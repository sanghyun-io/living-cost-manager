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
#     (invisible/unwritable by CI), chown the staged tree to the CI account
#     while still inside staging, set leaf mode 0700, then rename into place
#     under the root-owned parent. CI has no write/rename rights on the
#     parent, so the fixed path "/…/lcm-production/app" cannot be swapped or
#     renamed by CI. After the rename root NEVER traverses, recursively
#     chowns/chmods, or executes anything inside the leaf — the leaf is
#     CI-owned and only CI-uid processes (register/deregister/status/run,
#     launched via sudo -u or launchd UserName) touch its contents.
#     Official package modes are installed as shipped (tar preserves the
#     exec bits); there is deliberately NO blanket chmod anywhere — blanket
#     chmod 0644 destroying Runner.Listener is one of the previous kit's
#     fixed P1 bugs.
#
#   /var/log/gamja-ci/lcm-production/                     LOG DIR
#     root:wheel 0700. Root pre-creates launchd.out.log / launchd.err.log
#     (regular files, 0640, NO file ACLs anywhere). launchd (running as root)
#     opens the log files and passes the descriptors to the uid-dropped CI
#     child — the runner writes through inherited fds, so no CI write ACL is
#     required on the directory or the files, and no CI-owned path is
#     traversed by root-side logging at all.
#
# Idempotency policy: INITIAL install only. If the leaf (or a previous
# bundle's public files) exists, FAIL without mutation. Re-imaging a live
# CI-owned appRoot is exactly the replace/repair race this design removes.
# Teardown is 06-remove.sh.
#
# Test hook: LCM_CI_TEST_MODE=1 + LCM_CI_PKG=<local tarball> + LCM_CI_INSTALL_
# ANCHOR + path env overrides let the behaviour tests run this real logic
# against a fixture tree as a normal user (no root, no network, no dscl, no
# account mutations). Production invocation never sets these.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"
# shellcheck disable=SC1091
source "$HERE/lib/lib-runner.sh"

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

# ---------- preconditions ----------
if [ "$TEST_MODE" != 1 ]; then
  if ! id "$LCM_CI_ACCOUNT" >/dev/null 2>&1; then
    echo "error: CI account $LCM_CI_ACCOUNT does not exist. Run 01-create-account.sh first." >&2
    exit 1
  fi
  if dscl . -read /Groups/admin GroupMembership 2>/dev/null | tr ' ' '\n' | grep -qx "$LCM_CI_ACCOUNT"; then
    echo "error: $LCM_CI_ACCOUNT is in admin group — refusing (security boundary violation)" >&2
    exit 1
  fi
  CI_ACCOUNT_UID="$(id -u "$LCM_CI_ACCOUNT")"
  if [ "$(id -gn "$LCM_CI_ACCOUNT")" != "$LCM_CI_ACCOUNT" ]; then
    echo "error: $LCM_CI_ACCOUNT primary group is $(id -gn "$LCM_CI_ACCOUNT") (must be its own dedicated group)" >&2
    exit 1
  fi
  if [ ! -d "$LCM_CI_HOME" ] || [ -L "$LCM_CI_HOME" ]; then
    echo "error: CI home $LCM_CI_HOME missing or symlinked — re-run 01 flow" >&2
    exit 1
  fi
  expect_dir_owner_uid "$LCM_CI_HOME" "$CI_ACCOUNT_UID" || {
    echo "error: CI home owner mismatch" >&2; exit 1; }
  expect_dir_mode "$LCM_CI_HOME" 700 || {
    echo "error: CI home must be mode 700" >&2; exit 1; }
  if [ "$(stat -f '%u' "$(dirname "$LCM_CI_HOME")")" != 0 ]; then
    echo "error: home parent must be root-owned" >&2; exit 1
  fi
else
  CI_ACCOUNT_UID="$EUID_NOW"   # fixture mode: current user plays the CI role
fi

# ---------- parent path: anchor-validated ancestry, no symlinks ----------
reject_symlink_components "$LCM_CI_PARENT" || {
  echo "error: symlink component in parent path — refusing" >&2; exit 1; }
reject_symlink_components "$ANCHOR" || {
  echo "error: symlink component in install anchor — refusing" >&2; exit 1; }
expect_real_dir "$ANCHOR" || { echo "error: install anchor $ANCHOR is not a real directory" >&2; exit 1; }
expect_dir_owner_uid "$ANCHOR" "$TRUSTED_OWNER_UID" || {
  echo "error: install anchor $ANCHOR not owned by trusted uid $TRUSTED_OWNER_UID" >&2; exit 1; }
expect_dir_no_group_world_write "$ANCHOR" || {
  echo "error: install anchor $ANCHOR has group/world write" >&2; exit 1; }

# Walk every component from the anchor down to the parent, validating existing
# ones and creating missing ones (root:wheel 0755 in production; fixture
# pre-creates nothing special — test user just mkdirs under its own anchor).
TAIL="${LCM_CI_PARENT#"$ANCHOR"/}"
CUR="$ANCHOR"
if [ "$TAIL" = "$LCM_CI_PARENT" ]; then
  echo "error: parent $LCM_CI_PARENT is not under anchor $ANCHOR" >&2; exit 1
fi
IFS='/'
for seg in $TAIL; do
  [ -n "$seg" ] || continue
  CUR="$CUR/$seg"
  if [ -e "$CUR" ] || [ -L "$CUR" ]; then
    expect_real_dir "$CUR" || { echo "error: $CUR is not a real directory" >&2; exit 1; }
    expect_dir_owner_uid "$CUR" "$TRUSTED_OWNER_UID" || {
      echo "error: $CUR not owned by trusted uid" >&2; exit 1; }
    expect_dir_no_group_world_write "$CUR" || {
      echo "error: $CUR writable by group/world" >&2; exit 1; }
  else
    mkdir "$CUR"
    if [ "$EUID_NOW" -eq 0 ]; then chown root:wheel "$CUR"; fi
    chmod 0755 "$CUR"
  fi
done
unset IFS
# Final tightening: the parent gets 0755 and, if leaf already exists, stop.
chmod 0755 "$LCM_CI_PARENT"
if [ -e "$LCM_CI_APP_ROOT" ] || [ -L "$LCM_CI_APP_ROOT" ]; then
  echo "error: leaf $LCM_CI_APP_ROOT already exists — this script only does the initial fresh install and never repairs or replaces a CI-owned appRoot (use 06-remove.sh / manual teardown)" >&2
  exit 1
fi
for public in runner-config.env lib.sh register.sh manifest.txt; do
  if [ -e "$LCM_CI_PARENT/$public" ] || [ -L "$LCM_CI_PARENT/$public" ]; then
    echo "error: $LCM_CI_PARENT/$public already exists — refusing over an existing install" >&2
    exit 1
  fi
done

# Git provenance: public control scripts must come from a clean reviewed tree.
if [ "$TEST_MODE" != 1 ]; then
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain -- scripts/ci/runner .github/workflows)" ]; then
    echo "error: scripts/ci/runner or .github/workflows dirty — commit the reviewed tree before installing" >&2
    exit 1
  fi
  GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
else
  GIT_SHA="test-mode"
fi

# ---------- package fetch + verify (root-only staging) ----------
STAGE="$LCM_CI_PARENT/.install-staging-$$"
mkdir "$STAGE"
chmod 0700 "$STAGE"
if [ "$EUID_NOW" -eq 0 ]; then chown root:wheel "$STAGE"; fi
cleanup() { rm -rf "$STAGE" 2>/dev/null || true; }
trap cleanup EXIT

PKG="$STAGE/actions-runner.tar.gz"
if [ -n "${LCM_CI_PKG:-}" ]; then
  [ -f "$LCM_CI_PKG" ] || { echo "error: LCM_CI_PKG not found: $LCM_CI_PKG" >&2; exit 1; }
  cp "$LCM_CI_PKG" "$PKG"
elif [ "$TEST_MODE" = 1 ]; then
  echo "error: test mode requires LCM_CI_PKG (fixtures must not hit the network)" >&2
  exit 1
else
  echo "downloading official runner $LCM_CI_RUNNER_VERSION (pinned URL)..."
  curl -fL --retry 3 -o "$PKG" "$LCM_CI_RUNNER_URL"
fi
echo "$LCM_CI_RUNNER_SHA256  $PKG" | shasum -a 256 -c -

mkdir "$STAGE/app"
tar -xzf "$PKG" -C "$STAGE/app"
# Note: the official v2.338.0 package legitimately contains symlinks inside
# externals/ (node bin wrappers). They live in the CI-owned leaf, which root
# never traverses after install. The symlink-free requirements validated above
# apply to root-side paths (anchor ancestry, parent, leaf entry), NOT to
# package contents.

# Assert official entrypoints exist with package exec modes preserved —
# verification only, never corrective chmod.
for f in config.sh run.sh env.sh safe_sleep.sh run-helper.sh.template bin/Runner.Listener; do
  expect_executable_regular_file "$STAGE/app/$f" || {
    echo "error: package entrypoint $f missing or lost exec mode — refusing to install" >&2
    exit 1
  }
done
expect_regular_file "$STAGE/app/run-helper.cmd.template" || {
  echo "error: run-helper.cmd.template missing" >&2; exit 1; }
[ -d "$STAGE/app/externals" ] || { echo "error: externals/ missing" >&2; exit 1; }

# ONE-TIME ownership hand: chown the staged tree to the CI account BEFORE the
# rename, while it is still inside the root-only 0700 staging dir.
if [ "$EUID_NOW" -eq 0 ]; then
  chown -R "$LCM_CI_ACCOUNT:$LCM_CI_ACCOUNT" "$STAGE/app"
fi
chmod 700 "$STAGE/app"
mv "$STAGE/app" "$LCM_CI_APP_ROOT"   # atomic rename under the root-owned parent
cleanup
trap - EXIT

# ---------- public root-owned control scripts (secret-free) ----------
install_public() { # $1 source-rel-path $2 dest-name $3 mode
  local src="$REPO_ROOT/scripts/ci/runner/$1" dst="$LCM_CI_PARENT/$2"
  [ -f "$src" ] || { echo "error: missing $src" >&2; exit 1; }
  cp "$src" "$dst"
  chmod "$3" "$dst"
  if [ "$EUID_NOW" -eq 0 ]; then chown root:wheel "$dst"; fi
}
install_public "rootctl/register.sh"        register.sh        0755
install_public "rootctl/deregister.sh"      deregister.sh      0755
install_public "rootctl/runner-status.sh"   runner-status.sh   0755
install_public "rootctl/run-runner.sh"      run-runner.sh      0755
install_public "lib/lib-runner.sh"          lib.sh             0644
install_public "runner-version.env"         runner-config.env  0644

# ---------- log dir + pre-created fd targets (NO ACLs) ----------
reject_symlink_components "$LCM_CI_LOG_DIR" || {
  echo "error: symlink component in log path — refusing" >&2; exit 1; }
LOG_PARENT_DIR="$(dirname "$LCM_CI_LOG_DIR")"
for a in "$LOG_PARENT_DIR" "$LCM_CI_LOG_DIR"; do
  if [ ! -e "$a" ]; then
    mkdir "$a"
    if [ "$EUID_NOW" -eq 0 ]; then chown root:wheel "$a"; fi
    chmod 0755 "$a"
  else
    expect_real_dir "$a" || { echo "error: $a not a real directory" >&2; exit 1; }
    expect_dir_owner_uid "$a" "$TRUSTED_OWNER_UID" || { echo "error: $a owner mismatch" >&2; exit 1; }
  fi
done
chmod 0700 "$LCM_CI_LOG_DIR"
if [ "$EUID_NOW" -eq 0 ]; then chown root:wheel "$LCM_CI_LOG_DIR"; fi
for logfile in launchd.out.log launchd.err.log; do
  LF="$LCM_CI_LOG_DIR/$logfile"
  if [ -e "$LF" ] || [ -L "$LF" ]; then
    [ -L "$LF" ] && { echo "error: $LF is a symlink — refusing" >&2; exit 1; }
    LF_UID="$(stat -f '%u' "$LF" 2>/dev/null || echo none)"
    [ "$LF_UID" = "$TRUSTED_OWNER_UID" ] || {
      echo "error: $LF not owned by trusted uid — refusing" >&2; exit 1; }
  else
    : > "$LF"   # fresh regular file created by root; fd passed to CI child
  fi
  chmod 0640 "$LF"
  if [ "$EUID_NOW" -eq 0 ]; then chown root:wheel "$LF"; fi
done

# ---------- manifest ----------
{
  echo "# LCM CI runner install manifest"
  echo "# git: $GIT_SHA"
  echo "# runner: $LCM_CI_RUNNER_VERSION ($LCM_CI_RUNNER_URL)"
  echo "# runner tarball sha256: $LCM_CI_RUNNER_SHA256"
  echo "# leaf: $LCM_CI_APP_ROOT (uid $CI_ACCOUNT_UID, mode 0700, CI-owned, rename-installed fresh only)"
  for f in register.sh deregister.sh runner-status.sh run-runner.sh lib.sh runner-config.env; do
    printf '%s  %s\n' "$(shasum -a 256 "$LCM_CI_PARENT/$f" | awk '{print $1}')" "$LCM_CI_PARENT/$f"
  done
} > "$LCM_CI_PARENT/manifest.txt"
chmod 0644 "$LCM_CI_PARENT/manifest.txt"
if [ "$EUID_NOW" -eq 0 ]; then chown root:wheel "$LCM_CI_PARENT/manifest.txt"; fi

echo ""
echo "installed official appRoot at $LCM_CI_APP_ROOT (CI-owned 0700)"
echo "public root-owned control scripts + manifest in $LCM_CI_PARENT"
echo "log dir $LCM_CI_LOG_DIR (0700 trusted uid; files 0640; NO ACLs)"
echo ""
echo "next steps:"
echo "  1. register (Owner terminal, token piped via stdin, no token in argv):"
echo "       sudo scripts/ci/runner/03-register-runner.sh"
echo "  2. sudo scripts/ci/runner/04-install-launchd.sh"
echo "  3. sudo scripts/ci/runner/05-verify.sh"
