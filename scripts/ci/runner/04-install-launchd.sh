#!/bin/bash
# Install the root-owned LaunchDaemon for the LCM runner.
#
# Trust model:
#   - Program is the root-owned immutable wrapper $PARENT/run-runner.sh.
#     launchd drops uid/gid to UserName/GroupName (lcm-ci) BEFORE exec, so
#     the wrapper — and everything it execs inside the CI-owned leaf — runs
#     unprivileged. Root never executes leaf contents.
#   - WorkingDirectory is the CI-owned official appRoot (the runner expects
#     its state files next to its binaries).
#   - Logs: root-owned dir 0700 with root pre-created 0640 regular files.
#     launchd opens them as root and passes the fds to the uid-dropped child;
#     no ACLs, no CI path traversal by root-side logging.
#   - KeepAlive SuccessfulExit=false mirrors official run.sh semantics:
#     clean stop (including after config.sh remove) does NOT restart;
#     retryable codes are handled inside run.sh itself.
#   - RUNNER_MANUALLY_TRAP_SIG=1 makes run.sh install INT/TERM handlers that
#     signal the whole child process group, so `launchctl bootout` stops the
#     listener cleanly instead of orphaning it.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run with sudo" >&2; exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"
# shellcheck disable=SC1091
source "$HERE/lib/lib-runner.sh"

PARENT="$LCM_CI_PARENT"
LEAF="$LCM_CI_APP_ROOT"
LOG_DIR="$LCM_CI_LOG_DIR"
PLIST_PATH="/Library/LaunchDaemons/$LCM_CI_LAUNCHD_LABEL.plist"
WRAPPER="$PARENT/run-runner.sh"

echo "== preconditions =="
reject_symlink_components "$PARENT" || { echo "error: symlink in parent path" >&2; exit 1; }
expect_dir_owner_uid "$PARENT" 0 || { echo "error: parent not root-owned" >&2; exit 1; }
expect_dir_no_group_world_write "$PARENT" || { echo "error: parent group/world writable" >&2; exit 1; }
expect_executable_regular_file "$WRAPPER" || {
  echo "error: root wrapper $WRAPPER missing/not root-executable — run 02 first" >&2; exit 1; }
[ "$(stat -f '%u' "$WRAPPER")" = 0 ] || { echo "error: wrapper not root-owned" >&2; exit 1; }
expect_executable_regular_file "$PARENT/register.sh" || { echo "error: register.sh missing" >&2; exit 1; }
expect_regular_file "$PARENT/runner-config.env" || { echo "error: runner-config.env missing" >&2; exit 1; }
expect_regular_file "$PARENT/manifest.txt" || { echo "error: manifest.txt missing" >&2; exit 1; }

# Leaf identity by stat of its entry in the root-owned parent (CI cannot
# rename/replace the entry there). Root does not traverse the leaf contents;
# the registration check runs as the CI uid via the root-owned probe.
reject_symlink_components "$LEAF" || { echo "error: symlink at leaf path" >&2; exit 1; }
expect_real_dir "$LEAF" || { echo "error: leaf missing — run 02 first" >&2; exit 1; }
expect_dir_owner_uid "$LEAF" "$(id -u "$LCM_CI_ACCOUNT")" || {
  echo "error: leaf not owned by $LCM_CI_ACCOUNT" >&2; exit 1; }

if ! sudo -n -u "$LCM_CI_ACCOUNT" "$PARENT/runner-status.sh" configured >/dev/null 2>&1; then
  echo "error: runner not configured yet (or probe failed) — run 03-register-runner.sh first" >&2
  exit 1
fi

[ -d "$LOG_DIR" ] && [ ! -L "$LOG_DIR" ] || { echo "error: log dir missing — run 02 first" >&2; exit 1; }
expect_dir_owner_uid "$LOG_DIR" 0 || { echo "error: log dir not root-owned" >&2; exit 1; }
for logfile in launchd.out.log launchd.err.log; do
  LF="$LOG_DIR/$logfile"
  expect_regular_file "$LF" || { echo "error: pre-created log $LF missing" >&2; exit 1; }
  [ "$(stat -f '%u' "$LF")" = 0 ] || { echo "error: log $LF not root-owned" >&2; exit 1; }
  expect_no_acl "$LF" || { echo "error: log $LF carries ACL entries — unexpected" >&2; exit 1; }
done
expect_no_acl "$LOG_DIR" || { echo "error: log dir carries ACL entries — unexpected" >&2; exit 1; }

if [ -e "$PLIST_PATH" ] || [ -L "$PLIST_PATH" ]; then
  echo "error: $PLIST_PATH already exists — refusing to overwrite another install" >&2
  exit 1
fi

echo "== render + validate plist =="
TMPDIR_ROOT="$(mktemp -d /tmp/lcm-ci-plist.XXXXXX)"
trap 'rm -rf "$TMPDIR_ROOT"' EXIT
chmod 700 "$TMPDIR_ROOT"
TMP_PLIST="$TMPDIR_ROOT/$LCM_CI_LAUNCHD_LABEL.plist"

sed \
  -e "s|__PARENT__|$PARENT|g" \
  -e "s|__LEAF__|$LEAF|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  -e "s|__ACCOUNT__|$LCM_CI_ACCOUNT|g" \
  -e "s|__ACCOUNT_HOME__|$LCM_CI_HOME|g" \
  -e "s|__LAUNCHD_LABEL__|$LCM_CI_LAUNCHD_LABEL|g" \
  "$HERE/com.gamjaworld.lcm-ci-actions-runner.plist.template" > "$TMP_PLIST"

plutil -lint "$TMP_PLIST" >/dev/null

chown root:wheel "$TMP_PLIST"
chmod 644 "$TMP_PLIST"
mv "$TMP_PLIST" "$PLIST_PATH"

echo "== bootstrap system daemon =="
launchctl bootstrap system "$PLIST_PATH"
sleep 2
launchctl kickstart -p "system/$LCM_CI_LAUNCHD_LABEL" >/dev/null 2>&1 || true

echo "installed + bootstrapped $LCM_CI_LAUNCHD_LABEL"
echo "  Program : $WRAPPER (root-owned wrapper; runs as $LCM_CI_ACCOUNT)"
echo "  Leaf    : $LEAF (CI-owned official appRoot, WorkingDirectory)"
echo "  Logs    : $LOG_DIR (root-owned 0700 dir, 0640 files, no ACLs)"
echo "verify: sudo scripts/ci/runner/05-verify.sh"
