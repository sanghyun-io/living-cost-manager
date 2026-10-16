# shellcheck shell=bash
# Shared validation helpers for the LCM CI runner kit (rootctl scripts).
# This file ships root-owned 0644 inside the install parent next to the
# control scripts and is also sourced directly by the behavioural tests in
# security.test.ts against fixture trees. No side effects when sourced.
#
# Trust model reminder (official single-appRoot layout):
#   - the LEAF (runner appRoot) is CI-owned 0700; root performs ONE fresh
#     install of it (staging + rename under the root-owned parent) and never
#     traverses/recursively mutates/executes its contents as root afterwards;
#   - everything privileged (plist, wrapper, control scripts, manifest) is
#     root-owned inside the PARENT, which CI cannot write to (so CI cannot
#     swap/rename the leaf or the parent's files);
#   - therefore symlink rejections matter for the paths ROOT-side programs
#     inspect: parent ancestry, the leaf entry itself, log dir/files.

# Reject if ANY component of an absolute path is a symlink. This prevents a
# lower-privilege actor from redirecting privileged metadata reads.
reject_symlink_components() {
  local path="$1" probe="" segment old_ifs
  [ -n "$path" ] || return 1
  case "$path" in /*) ;; *) return 1 ;; esac
  old_ifs="${IFS-}"
  IFS='/'
  for segment in $path; do
    [ -n "$segment" ] || continue
    probe="$probe/$segment"
    if [ -L "$probe" ]; then
      IFS="${old_ifs-$' \t\n'}"
      return 1
    fi
  done
  IFS="${old_ifs-$' \t\n'}"
  return 0
}

# Real directory (not a symlink, not a file) at exactly this path.
expect_real_dir() {
  local p="$1"
  [ -d "$p" ] && [ ! -L "$p" ]
}

expect_dir_owner_name() {
  local p="$1" owner="$2" actual
  actual="$(stat -f '%Su' "$p" 2>/dev/null)" || return 1
  [ "$actual" = "$owner" ]
}

expect_dir_owner_uid() {
  local p="$1" uid="$2" actual
  actual="$(stat -f '%u' "$p" 2>/dev/null)" || return 1
  [ "$actual" = "$uid" ]
}

# Exact octal mode (3-digit, e.g. 700 / 755).
expect_dir_mode() {
  local p="$1" want="$2" actual
  actual="$(stat -f '%A' "$p" 2>/dev/null)" || return 1
  # normalise leading zero: stat -f '%A' prints e.g. 700
  [ "$((8#$actual))" -eq "$((8#$want))" ]
}

# No group/world write for directories root-side programs trust.
expect_dir_no_group_world_write() {
  local p="$1" actual
  actual="$(stat -f '%A' "$p" 2>/dev/null)" || return 1
  [ $(( 8#$actual & 8#022 )) -eq 0 ]
}

expect_regular_file() {
  local p="$1"
  [ -f "$p" ] && [ ! -L "$p" ]
}

# POSIX checks alone are insufficient on APFS: an ACL entry (possibly
# inherited) can grant another principal write/delete even while the mode is
# 0755 root-owned. Every root-trusted path therefore passes BOTH the POSIX
# owner/mode checks and this ACL check, before any mutation or ownership
# handoff.
#
# Policy (conservative; we verify, never mutate ACLs):
#   * zero ACL entries                -> accept (standard state of /Library,
#                                       /Users, /private/var/log on this host)
#   * every entry is a strict deny    -> accept (macOS ships deny-delete and
#                                       similar deny ACEs on system paths)
#   * ANY allow entry (even read)     -> REJECT
#   * ANY unparseable line            -> REJECT (fail closed)
# A rejection means a human investigates; this kit never clears or rewrites
# ACLs on paths it did not create (no permission weakening, no auto-delete).
expect_acl_safe() {
  local p="$1" out n line
  out="$(LC_ALL=C ls -lde "$p" 2>&1)" || return 1
  n="$(printf '%s\n' "$out" | wc -l | tr -d '[:space:]')"
  [ "$n" -le 1 ] && return 0
  while IFS= read -r line; do
    # any allow ACE fails
    case "$line" in
      *" allow "*) return 1 ;;
    esac
    # strict deny-ACE shape only; anything else fails closed
    printf '%s\n' "$line" | LC_ALL=C grep -Eq \
      '^[[:space:]]*[0-9]+:[[:space:]]+(user|group|everyone)[:.][^[:space:]]*[[:space:]]+deny[[:space:]]+[A-Za-z0-9_.,-]+([[:space:]]+\([A-Za-z0-9_.,-]+\))?[[:space:]]*$' \
      || return 1
  done <<EOF
$(printf '%s\n' "$out" | LC_ALL=C tail -n +2)
EOF
  return 0
}

# Stricter variant used on artifacts THIS script created (fresh files should
# carry no ACL at all; deny-only is still tolerated to survive inherited deny
# ACEs on some hosts).
expect_no_acl() {
  local p="$1" lines
  lines="$(LC_ALL=C ls -lde "$p" 2>/dev/null | wc -l | tr -d '[:space:]')" || return 1
  [ "$lines" = "1" ] || expect_acl_safe "$p"
}

expect_executable_regular_file() {
  local p="$1"
  [ -f "$p" ] && [ ! -L "$p" ] && [ -x "$p" ]
}

# Registration/removal tokens are opaque short-lived secrets. Reject empty,
# whitespace/control characters, CRLF residue, absurd lengths — this is a
# corruption guard, NOT entropy validation. Never echo the token itself.
valid_token_shape() {
  local t="$1"
  [ -n "$t" ] || return 1
  [ "${#t}" -ge 20 ] && [ "${#t}" -le 255 ] || return 1
  case "$t" in
    *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  return 0
}

require_not_root() {
  if [ "$(id -u)" -eq 0 ]; then
    echo "error: must NOT run as root (official config.sh/run.sh refuse root as well)" >&2
    return 1
  fi
  return 0
}

# Parse ONLY simple identity fields from the official .runner JSON, via the
# system JSON-capable parser /usr/bin/plutil (never sed approximations).
# Real Runner.Listener writes .runner PRETTY-PRINTED (multi-line, space after
# colon); sed regexes that require `"field":"value"` reject valid runners.
# Content is CI-owned and therefore untrusted: callers must compare extracted
# values against fixed constants/types and must never use them as paths.
# plutil supports JSON input for -extract (verified on this host 2026-10-17
# against pretty, minified and malformed fixtures). Missing plutil = fail
# closed — no substitute parser.
runner_json_field() {
  # $1 = .runner FILE PATH (opened by the caller's own uid), $2 = fixed field
  [ -x /usr/bin/plutil ] || return 1
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null
}

runner_identity_matches() {
  # $1 = .runner file path, $2 = expected agent name, $3 = expected agent id (optional)
  local file="$1" want_name="$2" want_id="${3:-}" name id
  [ -n "$want_name" ] || return 1
  name="$(runner_json_field "$file" agentName)" || true
  id="$(runner_json_field "$file" agentId)" || true
  # exact string comparison against fixed constants; object/array/other JSON
  # types would surface as raw JSON text here and cannot equal the constants
  [ -n "$name" ] || return 1
  [ "$name" = "$want_name" ] || return 1
  [ -n "$id" ] || return 1
  case "$id" in ''|*[!0-9]*) return 1 ;; esac   # agentId must be numeric
  if [ -n "$want_id" ]; then
    [ "$id" = "$want_id" ] || return 1
  fi
  return 0
}
