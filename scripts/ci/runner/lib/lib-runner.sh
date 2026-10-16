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

# Parse ONLY simple identity fields from the official .runner JSON. Content is
# CI-owned and therefore untrusted: callers must compare extracted values
# against fixed constants and must never use them as paths.
runner_json_field() {
  # $1 = json text, $2 = field name (fixed literal from our own code)
  local json="$1" field="$2"
  printf '%s' "$json" | tr -d '\n' \
    | sed -n "s/.*\"$field\":\"\{0,1\}\([^,\"}]*\)\"\{0,1\}[,}].*/\1/p" | head -n 1
}

runner_identity_matches() {
  # $1 = .runner json text, $2 = expected agent name, $3 = expected agent id (optional)
  local json="$1" want_name="$2" want_id="${3:-}" name id
  name="$(runner_json_field "$json" agentName)"
  id="$(runner_json_field "$json" agentId)"
  [ "$name" = "$want_name" ] || return 1
  if [ -n "$want_id" ]; then
    [ "$id" = "$want_id" ] || return 1
  fi
  return 0
}

# Verify a path carries NO POSIX ACL entries. On macOS the ls mode column
# never shows '+': `ls -lde` prints extra numbered lines for each ACL entry,
# so a clean file/dir produces exactly one line. (The '@' xattr marker, e.g.
# com.apple.provenance on fresh files, is NOT an ACL and is fine here.)
expect_no_acl() {
  local p="$1" lines
  lines="$(ls -lde "$p" 2>/dev/null | wc -l | tr -d '[:space:]')" || return 1
  [ "$lines" = "1" ]
}
