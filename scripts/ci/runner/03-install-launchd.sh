#!/bin/bash
# Install the root-owned LaunchDaemon that runs the LCM runner as the
# dedicated non-admin account (mirrors how the existing runners were
# installed; svc.sh is not used because it demands sudo from inside the
# CI account). This touches ONLY the LCM runner: it never edits, relabels,
# stops or reuses the Harudo (/Users/sanghyun/actions-runner) or Figuredeal
# (/Users/sanghyun/actions-runner-figuredeal) listeners.
#
#   sudo scripts/ci/runner/03-install-launchd.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run with sudo" >&2; exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"

RUNNER_DIR="/Users/$LCM_CI_ACCOUNT/actions-runner"
LOG_DIR="/Users/$LCM_CI_ACCOUNT/actions-runner-logs"
PLIST_PATH="/Library/LaunchDaemons/$LCM_CI_LAUNCHD_LABEL.plist"

if [ ! -x "$RUNNER_DIR/runsvc.sh" ] || [ ! -f "$RUNNER_DIR/.credentials" ]; then
  echo "error: runner not registered under $RUNNER_DIR — run 02-install-runner.sh first" >&2
  exit 1
fi
if [ -f "$PLIST_PATH" ]; then
  echo "error: $PLIST_PATH already exists — refusing to overwrite another install" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
chown "$LCM_CI_ACCOUNT" "$LOG_DIR"
chmod 700 "$LOG_DIR"

TMP_PLIST="$PLIST_PATH.partial.$$"
sed \
  -e "s|__LAUNCHD_LABEL__|$LCM_CI_LAUNCHD_LABEL|g" \
  -e "s|__RUNNER_DIR__|$RUNNER_DIR|g" \
  -e "s|__ACCOUNT__|$LCM_CI_ACCOUNT|g" \
  -e "s|__ACCOUNT_HOME__|/Users/$LCM_CI_ACCOUNT|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$HERE/com.gamjaworld.lcm-ci-actions-runner.plist.template" > "$TMP_PLIST"
plutil -lint "$TMP_PLIST"
chown root:wheel "$TMP_PLIST"
chmod 644 "$TMP_PLIST"
mv "$TMP_PLIST" "$PLIST_PATH"

launchctl bootstrap system "$PLIST_PATH"
sleep 2
launchctl kickstart -p "system/$LCM_CI_LAUNCHD_LABEL" >/dev/null 2>&1 || true
echo "installed + bootstrapped system daemon $LCM_CI_LAUNCHD_LABEL"
echo "verify: sudo scripts/ci/runner/04-verify.sh"
