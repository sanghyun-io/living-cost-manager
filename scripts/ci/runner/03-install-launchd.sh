#!/bin/bash
# Install the root-owned LaunchDaemon that runs the LCM runner.
#
# Architecture (P1 root symlink fix - CORRECTED):
#   - Program: /Library/Application Support/GamjaWorld/CI/lcm-production/runsvc.sh
#     (root-owned, immutable, CI cannot modify)
#   - WorkingDirectory: /Library/.../lcm-runner/working (CI-owned, writable)
#   - Logs: /var/log/gamja-ci/lcm-production (root-owned, pre-created files)
#   - UserName: lcm-ci (process runs as CI user, not root)
#
# Security properties:
#   - Root never traverses into CI-owned directories
#   - Log files are pre-created by root, CI can only append via FD
#   - Runner binaries preserve executable permissions
#   - launchd UserName drops uid before exec (valid security model)
#
# Prerequisites:
#   - 01-create-account.sh has created the CI account
#   - 00-bootstrap-bundle.sh has created the root-owned bundle
#   - CI user has created working directory
#   - 02-register-runner.sh has registered the runner
#
# Usage:
#   sudo scripts/ci/runner/03-install-launchd.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run with sudo" >&2; exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"

BUNDLE_ROOT="/Library/Application Support/GamjaWorld/CI/lcm-production"
RUNNER_PARENT="/Library/Application Support/GamjaWorld/CI/lcm-runner"
RUNNER_WORK_DIR="$RUNNER_PARENT/working"
LOG_DIR="/var/log/gamja-ci/lcm-production"
PLIST_PATH="/Library/LaunchDaemons/$LCM_CI_LAUNCHD_LABEL.plist"

# Verify bundle exists and is root-owned
if [ ! -d "$BUNDLE_ROOT" ]; then
  echo "error: bundle $BUNDLE_ROOT does not exist. Run 00-bootstrap-bundle.sh first." >&2
  exit 1
fi

BUNDLE_OWNER="$(stat -f '%Su' "$BUNDLE_ROOT")"
if [ "$BUNDLE_OWNER" != "root" ]; then
  echo "error: bundle is owned by $BUNDLE_OWNER, not root — security violation" >&2
  exit 1
fi

# Verify bundle has runsvc.sh
if [ ! -x "$BUNDLE_ROOT/runsvc.sh" ]; then
  echo "error: bundle missing runsvc.sh" >&2
  exit 1
fi

# Verify runner parent exists and is root-owned
if [ ! -d "$RUNNER_PARENT" ]; then
  echo "error: runner parent $RUNNER_PARENT does not exist. Run 00-bootstrap-bundle.sh first." >&2
  exit 1
fi

PARENT_OWNER="$(stat -f '%Su' "$RUNNER_PARENT")"
if [ "$PARENT_OWNER" != "root" ]; then
  echo "error: runner parent is owned by $PARENT_OWNER, not root — security violation" >&2
  exit 1
fi

# Verify working directory exists and is CI-owned
if [ ! -d "$RUNNER_WORK_DIR" ]; then
  echo "error: working directory $RUNNER_WORK_DIR does not exist." >&2
  echo "CI user must create it first:" >&2
  echo "  sudo -u $LCM_CI_ACCOUNT mkdir -p '$RUNNER_WORK_DIR'" >&2
  echo "  sudo -u $LCM_CI_ACCOUNT chmod 0700 '$RUNNER_WORK_DIR'" >&2
  exit 1
fi

WORK_OWNER="$(stat -f '%Su' "$RUNNER_WORK_DIR")"
if [ "$WORK_OWNER" != "$LCM_CI_ACCOUNT" ]; then
  echo "error: working directory is owned by $WORK_OWNER, not $LCM_CI_ACCOUNT — security violation" >&2
  exit 1
fi

# Verify runner is registered
if [ ! -f "$RUNNER_WORK_DIR/.credentials" ]; then
  echo "error: runner not registered in $RUNNER_WORK_DIR — run 02-register-runner.sh first" >&2
  exit 1
fi

# Verify log directory exists and is root-owned
if [ ! -d "$LOG_DIR" ]; then
  echo "error: log directory $LOG_DIR does not exist. Run 00-bootstrap-bundle.sh first." >&2
  exit 1
fi

LOG_OWNER="$(stat -f '%Su' "$LOG_DIR")"
if [ "$LOG_OWNER" != "root" ]; then
  echo "error: log directory is owned by $LOG_OWNER, not root — security violation" >&2
  exit 1
fi

# Verify log files exist and are root-owned
for logfile in launchd.out.log launchd.err.log; do
  LOGFILE="$LOG_DIR/$logfile"
  if [ ! -f "$LOGFILE" ]; then
    echo "error: log file $LOGFILE does not exist. Run 00-bootstrap-bundle.sh first." >&2
    exit 1
  fi
  LOGFILE_OWNER="$(stat -f '%Su' "$LOGFILE")"
  if [ "$LOGFILE_OWNER" != "root" ]; then
    echo "error: log file $LOGFILE is owned by $LOGFILE_OWNER, not root — security violation" >&2
    exit 1
  fi
done

# Refuse to overwrite existing plist (prevent clobbering another install)
if [ -f "$PLIST_PATH" ]; then
  echo "error: $PLIST_PATH already exists — refusing to overwrite another install" >&2
  exit 1
fi

# Generate plist from template
TMP_PLIST="$PLIST_PATH.partial.$$"
sed \
  -e "s|__LAUNCHD_LABEL__|$LCM_CI_LAUNCHD_LABEL|g" \
  -e "s|__BUNDLE_ROOT__|$BUNDLE_ROOT|g" \
  -e "s|__RUNNER_WORK_DIR__|$RUNNER_WORK_DIR|g" \
  -e "s|__ACCOUNT__|$LCM_CI_ACCOUNT|g" \
  -e "s|__ACCOUNT_HOME__|/Users/$LCM_CI_ACCOUNT|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$HERE/com.gamjaworld.lcm-ci-actions-runner.plist.template" > "$TMP_PLIST"

# Validate plist syntax
plutil -lint "$TMP_PLIST"

# Install plist as root-owned
chown root:wheel "$TMP_PLIST"
chmod 644 "$TMP_PLIST"
mv "$TMP_PLIST" "$PLIST_PATH"

# Bootstrap the daemon
launchctl bootstrap system "$PLIST_PATH"
sleep 2
launchctl kickstart -p "system/$LCM_CI_LAUNCHD_LABEL" >/dev/null 2>&1 || true

echo "installed + bootstrapped system daemon $LCM_CI_LAUNCHD_LABEL"
echo "  Program: $BUNDLE_ROOT/runsvc.sh (root-owned)"
echo "  WorkingDirectory: $RUNNER_WORK_DIR (CI-owned)"
echo "  Logs: $LOG_DIR (root-owned, pre-created files)"
echo "  UserName: $LCM_CI_ACCOUNT"
echo "verify: sudo scripts/ci/runner/04-verify.sh"
