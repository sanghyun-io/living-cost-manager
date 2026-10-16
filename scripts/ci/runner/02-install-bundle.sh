#!/bin/bash
# Fresh-install-only root bootstrap for the LCM dedicated runner.
#
# Architecture (official runner appRoot design — replaces the broken
# root-bundle/CI-working split, which upstream does not support because
# config.sh/run.sh self-locate their appRoot and write .credentials/.env/
# .runner/_work THERE):
#
#   /Library/Application Support/GamjaWorld/CI/lcm-production/   PARENT
#     root:wheel 0755, no CI-writable ACL/symlink anywhere in the ancestry.
#     Contains ONLY public, secret-free, root-owned immutable files:
#       runner-config.env      pinned version/repo/layout constants
#       lib.sh                 shared validation helpers
#       register.sh            token-via-stdin configure (runs as CI)
#       deregister.sh          token-via-stdin remove  (runs as CI)
#       runner-status.sh       read-only probe         (runs as CI)
#       run-runner.sh          launchd wrapper (execs leaf run.sh after uid drop)
#       manifest.txt           git provenance + sha256 of public files
#     app/                                                  LEAF (official appRoot)
#     Created EXCLUSIVELY during this first install: extract the verified
#     official tarball into a root-only 0700 staging dir under the parent
#     (invisible/unwritable by CI), then — as the LAST mutation step — chown
#     the staged tree to the CI account, mode 0700, and rename it into place
#     under the root-owned parent. CI has no write/rename rights on the
#     parent, so the fixed path "/…/lcm-production/app" cannot be swapped by
#     CI. After the rename root NEVER traverses, recursively chowns/chmods,
#     or executes anything inside the leaf.
#
#   /private/var/log/gamja-ci/lcm-production/               LOG DIR
#     canonical path (/var is a macOS SYMLINK — all validation uses the
#     /private/... form). root:wheel 0700. Root pre-creates launchd.out.log /
#     launchd.err.log (regular files, 0640, NO ACLs added by this kit).
#     launchd opens them as root and passes the fds to the uid-dropped CI
#     child — no CI write ACL, no CI-path traversal by root-side logging.
#
# Ordering guarantees (review P2):
#   * EVERY check that can fail — account/home, bundle ancestry, parent,
#     leaf/public-file absence, log-path ancestry and pre-existence, plist
#     absence, git provenance, package SHA + entrypoints — runs BEFORE the
#     first filesystem mutation or before any CI-owned state exists.
#   * Ownership handoff (chown staged leaf → rename) is the LAST mutation.
#     Failures before it leave no CI-owned files; if an unexpected failure
#     happens after the staged chown but before rename, the CI-owned copy is
#     still inside the root-only 0700 staging dir (invisible to CI) and the
#     EXIT trap removes it — nothing else is auto-deleted, and post-rename
#     reruns REFUSE (fresh-install-only) with a report instead of repairing.
#   * Directories/files are created with restrictive BIRTH MODES (mkdir -m,
#     umask 077) — never a default-0755 window awaiting chmod.
#
# ACL policy (review P1): POSIX owner/mode checks are NOT sufficient — an ACL
# entry (own or inherited) can grant another principal write/delete on a
# root-trusted path. Every existing component from the anchor through the
# parent, every component of the log path, every created dir/file, and every
# installed public control file must pass expect_acl_safe: zero ACL entries
# or strict deny-only entries. ANY allow ACE (even read-only) or unparseable
# ACE fails closed. This script NEVER adds, clears or mutates ACLs — a
# failing standard system ACL means a human investigates first (documented
# blocker, not auto-fixed).
#
# Idempotency policy: INITIAL install only; existing leaf/public files/log
# files => FAIL without mutation. Teardown is 06-remove.sh.
#
# Test hook: LCM_CI_TEST_MODE=1 + LCM_CI_PKG=<local tarball> +
# LCM_CI_INSTALL_ANCHOR + path env overrides let the behaviour tests run this
# real logic against a fixture tree as a normal user (no root, no network, no
# dscl, no account mutations). Production invocation never sets these.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"
# shellcheck disable=SC1091
source "$HERE/lib/lib-runner.sh"

umask 077

TEST_MODE="${LCM_CI_TEST_MODE:-0}"
EUID_NOW="$(id -u)"
if [ "$EUID_NOW" -eq 0 ]; then
  TRUSTED_OWNER_UID=0
elif [ "$TEST_MODE" != 1 ]; then
  echo "error: run with sudo (one-time owner authorization)" >&2
  exit 1
else
  TRUSTED_OWNER_UID="$EUID_NOW"
fi

ANCHOR="${LCM_CI_INSTALL_ANCHOR:-/Library}"
PLIST_PATH="/Library/LaunchDaemons/$LCM_CI_LAUNCHD_LABEL.plist"

fail() { echo "error: $*" >&2; exit 1; }

# validate_component DIR — owner/mode/no-write/symlink/ACL of one existing
# trusted-path component (used on the anchor..parent and log chains).
validate_component() {
  local a="$1"
  [ -L "$a" ] && { echo "error: symlink component at $a" >&2; return 1; }
  expect_real_dir "$a" || { echo "error: $a is not a real directory" >&2; return 1; }
  expect_dir_owner_uid "$a" "$TRUSTED_OWNER_UID" || { echo "error: $a not owned by trusted uid" >&2; return 1; }
  expect_dir_no_group_world_write "$a" || { echo "error: $a writable by group/world" >&2; return 1; }
  expect_acl_safe "$a" || {
    echo "error: $a carries an allow/unparseable ACL entry — refusing (investigate; this kit never modifies ACLs)" >&2
    return 1; }
}

# validate_file ROOT_TRUSTED_PATH — regular non-symlink file: owner + no
# group/world write + ACL-safe.
validate_control_file() {
  local f="$1"
  [ -L "$f" ] && { echo "error: $f is a symlink" >&2; return 1; }
  [ -f "$f" ] || { echo "error: $f missing" >&2; return 1; }
  [ "$(stat -f '%u' "$f")" = "$TRUSTED_OWNER_UID" ] || { echo "error: $f not owned by trusted uid" >&2; return 1; }
  local m; m="$(stat -f '%A' "$f")"
  [ $(( 8#$m & 8#022 )) -eq 0 ] || { echo "error: $f writable by group/world ($m)" >&2; return 1; }
  expect_acl_safe "$f" || { echo "error: $f carries allow/unparseable ACL" >&2; return 1; }
}

# ---------------- PHASE A: read-only preflight (NO mutations) -------------
if [ "$TEST_MODE" != 1 ]; then
  if ! id "$LCM_CI_ACCOUNT" >/dev/null 2>&1; then
    fail "CI account $LCM_CI_ACCOUNT does not exist — run 01-create-account.sh first"
  fi
  if dscl . -read /Groups/admin GroupMembership 2>/dev/null | tr ' ' '\n' | grep -qx "$LCM_CI_ACCOUNT"; then
    fail "$LCM_CI_ACCOUNT is in admin group (security boundary violation)"
  fi
  CI_ACCOUNT_UID="$(id -u "$LCM_CI_ACCOUNT")"
  [ "$(id -gn "$LCM_CI_ACCOUNT")" = "$LCM_CI_ACCOUNT" ] || \
    fail "$LCM_CI_ACCOUNT primary group is $(id -gn "$LCM_CI_ACCOUNT") (must be its own)"
  if [ ! -d "$LCM_CI_HOME" ] || [ -L "$LCM_CI_HOME" ]; then
    fail "CI home $LCM_CI_HOME missing or symlinked — re-run 01 flow"
  fi
  expect_dir_owner_uid "$LCM_CI_HOME" "$CI_ACCOUNT_UID" || fail "CI home owner mismatch"
  expect_dir_mode "$LCM_CI_HOME" 700 || fail "CI home must be mode 700"
  [ "$(stat -f '%u' "$(dirname "$LCM_CI_HOME")")" = 0 ] || fail "home parent must be root-owned"
  reject_symlink_components "$LCM_CI_HOME" || fail "symlink component in CI home path"
  expect_acl_safe "$LCM_CI_HOME" || fail "CI home carries allow/unparseable ACL"
else
  CI_ACCOUNT_UID="$EUID_NOW"   # fixture mode: current user plays the CI role
fi

# Bundle chain: canonical, symlink-free; validate EXISTING components from the
# anchor down; every failing check happens before any mkdir below.
reject_symlink_components "$LCM_CI_PARENT" || fail "symlink component in parent path — refusing"
reject_symlink_components "$ANCHOR" || fail "symlink component in install anchor — refusing"
validate_component "$ANCHOR" || fail "install anchor $ANCHOR failed validation"

TAIL="${LCM_CI_PARENT#"$ANCHOR"/}"
[ "$TAIL" = "$LCM_CI_PARENT" ] && fail "parent $LCM_CI_PARENT is not under anchor $ANCHOR"

if [ -e "$LCM_CI_APP_ROOT" ] || [ -L "$LCM_CI_APP_ROOT" ]; then
  fail "leaf $LCM_CI_APP_ROOT already exists — fresh install only, never repair/replace a CI-owned appRoot (use 06-remove.sh / manual teardown)"
fi
for public in runner-config.env lib.sh register.sh deregister.sh runner-status.sh run-runner.sh manifest.txt; do
  if [ -e "$LCM_CI_PARENT/$public" ] || [ -L "$LCM_CI_PARENT/$public" ]; then
    fail "$LCM_CI_PARENT/$public already exists — refusing over an existing install"
  fi
done
if [ -e "$PLIST_PATH" ] || [ -L "$PLIST_PATH" ]; then
  [ "$TEST_MODE" = 1 ] || fail "$PLIST_PATH already exists — refusing over an existing install"
fi

# Log chain (canonical /private/var/log/... in production): reject any
# symlink component over the WHOLE path (/var would trip here — use the
# /private form), enforce owner/mode/ACL from LOG_ANCHOR down, and fail on
# pre-created foreign log files before anything else exists.
LOG_ANCHOR="${LCM_CI_LOG_ANCHOR:-/private/var/log}"
reject_symlink_components "$LCM_CI_LOG_DIR" || fail "symlink component in log path (use canonical /private/... form; /var is a macOS symlink)"
CUR=""
IFS='/'
for seg in ${LCM_CI_LOG_DIR#/}; do
  [ -n "$seg" ] || continue
  CUR="$CUR/$seg"
  [ -L "$CUR" ] && fail "symlink component at $CUR — refusing"
  case "$CUR" in
    "$LOG_ANCHOR"|"${LOG_ANCHOR}"/*)
      if [ -d "$CUR" ]; then
        validate_component "$CUR" || fail "log-chain component $CUR failed validation"
      fi ;;
  esac
done
unset IFS
if [ -e "$LCM_CI_LOG_DIR" ]; then
  for logfile in launchd.out.log launchd.err.log; do
    LF="$LCM_CI_LOG_DIR/$logfile"
    if [ -e "$LF" ] || [ -L "$LF" ]; then
      [ -L "$LF" ] && fail "$LF is a symlink — refusing"
      validate_control_file "$LF" || fail "pre-existing $LF fails owner/mode/ACL validation"
    fi
  done
fi

# Git provenance (production): public control scripts must come from the
# committed, reviewed tree so the manifest pins what was reviewed.
if [ "$TEST_MODE" != 1 ]; then
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain -- scripts/ci/runner .github/workflows)" ]; then
    fail "scripts/ci/runner or .github/workflows dirty — commit the reviewed tree before installing"
  fi
  GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
else
  GIT_SHA="test-mode"
fi

# ---------------- PHASE B: root-private staging (first mutations) ----------
STAGE="$LCM_CI_PARENT/.install-staging-$$"
cleanup() { rm -rf "$STAGE" 2>/dev/null || true; }
# Create missing bundle-chain components (birth mode, then revalidate for
# inherited ACEs). This runs only after all abortable checks above passed.
CUR="$ANCHOR"
IFS='/'
for seg in ${LCM_CI_PARENT#"$ANCHOR"/}; do
  [ -n "$seg" ] || continue
  CUR="$CUR/$seg"
  if [ ! -e "$CUR" ]; then
    mkdir -m 0755 "$CUR" || fail "cannot create $CUR"
    if [ "$EUID_NOW" -eq 0 ]; then chown root:wheel "$CUR"; fi
    chmod 0755 "$CUR"
  fi
  # revalidate (including possibly inherited ACLs on the fresh component)
  validate_component "$CUR" || fail "component $CUR failed post-creation validation"
done
unset IFS

mkdir -m 0700 "$STAGE" || fail "cannot create staging"
if [ "$EUID_NOW" -eq 0 ]; then chown root:wheel "$STAGE"; fi
trap cleanup EXIT
expect_acl_safe "$STAGE" || fail "staging inherited an allow ACL"

PKG="$STAGE/actions-runner.tar.gz"
if [ -n "${LCM_CI_PKG:-}" ]; then
  [ -f "$LCM_CI_PKG" ] || fail "LCM_CI_PKG not found: $LCM_CI_PKG"
  cp "$LCM_CI_PKG" "$PKG"
elif [ "$TEST_MODE" = 1 ]; then
  fail "test mode requires LCM_CI_PKG (fixtures must not hit the network)"
else
  echo "downloading official runner $LCM_CI_RUNNER_VERSION (pinned URL)..."
  curl -fL --retry 3 -o "$PKG" "$LCM_CI_RUNNER_URL"
fi
echo "$LCM_CI_RUNNER_SHA256  $PKG" | shasum -a 256 -c - || fail "package SHA-256 mismatch"

mkdir -m 0700 "$STAGE/app"
tar -xzf "$PKG" -C "$STAGE/app"
# The official v2.338.0 package legitimately contains symlinks inside
# externals/ (node bin wrappers). They live in the CI-owned leaf, which root
# never traverses after install; symlink-free requirements apply to root-side
# paths (anchor ancestry, parent, leaf entry, log chain), NOT package files.

# Assert official entrypoints exist with package exec modes preserved —
# verification only, never corrective chmod.
for f in config.sh run.sh env.sh safe_sleep.sh run-helper.sh.template bin/Runner.Listener; do
  expect_executable_regular_file "$STAGE/app/$f" || \
    fail "package entrypoint $f missing or lost exec mode — refusing to install"
done
expect_regular_file "$STAGE/app/run-helper.cmd.template" || fail "run-helper.cmd.template missing"
[ -d "$STAGE/app/externals" ] || fail "externals/ missing"

# ---------------- PHASE C: log dir/files (root-owned) ----------------------
LOG_PARENT_DIR="$(dirname "$LCM_CI_LOG_DIR")"
for a in "$LOG_PARENT_DIR" "$LCM_CI_LOG_DIR"; do
  if [ ! -e "$a" ]; then
    mkdir -m 0700 "$a" || fail "cannot create $a"
    if [ "$EUID_NOW" -eq 0 ]; then chown root:wheel "$a"; fi
  fi
  validate_component "$a" || fail "$a failed validation"
done
chmod 0700 "$LCM_CI_LOG_DIR"
for logfile in launchd.out.log launchd.err.log; do
  LF="$LCM_CI_LOG_DIR/$logfile"
  if [ -e "$LF" ]; then
    validate_control_file "$LF" || fail "pre-existing $LF invalid"
  else
    : > "$LF"   # birth mode via umask 077 => 0600; tightened to 0640 below
    chmod 0640 "$LF"
    if [ "$EUID_NOW" -eq 0 ]; then chown root:wheel "$LF"; fi
  fi
  validate_control_file "$LF" || fail "$LF failed post-creation validation (check inherited ACL)"
done

# ---------------- PHASE D: public control files + manifest -----------------
install_public() { # $1 source-rel-path $2 dest-name $3 mode
  local src="$REPO_ROOT/scripts/ci/runner/$1" dst="$LCM_CI_PARENT/$2"
  [ -f "$src" ] || { echo "error: missing $src" >&2; exit 1; }
  [ -L "$src" ] && { echo "error: $src is a symlink in the repo tree — refusing" >&2; exit 1; }
  cp "$src" "$dst"
  chmod "$3" "$dst"
  if [ "$EUID_NOW" -eq 0 ]; then chown root:wheel "$dst"; fi
  validate_control_file "$dst" || { echo "error: installed $2 fails owner/mode/ACL validation" >&2; exit 1; }
}
install_public "rootctl/register.sh"        register.sh        0755
install_public "rootctl/deregister.sh"      deregister.sh      0755
install_public "rootctl/runner-status.sh"   runner-status.sh   0755
install_public "rootctl/run-runner.sh"      run-runner.sh      0755
install_public "lib/lib-runner.sh"          lib.sh             0644
install_public "runner-version.env"         runner-config.env  0644

{
  echo "# LCM CI runner install manifest"
  echo "# git: $GIT_SHA"
  echo "# runner: $LCM_CI_RUNNER_VERSION ($LCM_CI_RUNNER_URL)"
  echo "# runner tarball sha256: $LCM_CI_RUNNER_SHA256"
  echo "# leaf: $LCM_CI_APP_ROOT (uid $CI_ACCOUNT_UID, mode 0700, CI-owned, LAST-step rename, fresh-only)"
  for f in register.sh deregister.sh runner-status.sh run-runner.sh lib.sh runner-config.env; do
    printf '%s  %s\n' "$(shasum -a 256 "$LCM_CI_PARENT/$f" | awk '{print $1}')" "$LCM_CI_PARENT/$f"
  done
} > "$LCM_CI_PARENT/manifest.txt"
chmod 0644 "$LCM_CI_PARENT/manifest.txt"
if [ "$EUID_NOW" -eq 0 ]; then chown root:wheel "$LCM_CI_PARENT/manifest.txt"; fi
validate_control_file "$LCM_CI_PARENT/manifest.txt" || fail "manifest.txt failed validation"

# ---------------- PHASE E: ownership handoff + rename (LAST) ---------------
# This is the final mutation. chown happens while the tree is still inside
# the root-only 0700 staging dir; if anything fails between chown and the
# rename, the trap removes only the staging dir (CI never observed it).
if [ "$EUID_NOW" -eq 0 ]; then
  chown -R "$LCM_CI_ACCOUNT:$LCM_CI_ACCOUNT" "$STAGE/app" || \
    fail "PARTIAL-STATE: staged leaf ownership hand failed inside root-private staging; staging trap cleanup removed nothing else — inspect $STAGE before ANY retry"
fi
chmod 700 "$STAGE/app"
mv "$STAGE/app" "$LCM_CI_APP_ROOT" || \
  fail "PARTIAL-STATE: rename failed; staged leaf still inside root-private staging — inspect, no auto-retry"
cleanup
trap - EXIT

echo ""
echo "installed official appRoot at $LCM_CI_APP_ROOT (CI-owned 0700, last-step handoff)"
echo "public root-owned control scripts + manifest in $LCM_CI_PARENT"
echo "log dir $LCM_CI_LOG_DIR (0700 trusted uid; files 0640; no ACLs added)"
echo ""
echo "next steps:"
echo "  1. register (Owner terminal, token piped via stdin, no token in argv):"
echo "       sudo scripts/ci/runner/03-register-runner.sh"
echo "  2. sudo scripts/ci/runner/04-install-launchd.sh"
echo "  3. sudo scripts/ci/runner/05-verify.sh"
