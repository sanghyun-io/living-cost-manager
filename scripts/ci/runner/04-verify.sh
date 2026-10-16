#!/bin/bash
# Read-only verification of the LCM runner install. Safe to run twice —
# prints state, mutates nothing. Run the gh section as the operator account
# and the launchctl section with sudo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"

echo "== repository-scoped runner registration (GitHub API) =="
gh api "$LCM_CI_REPO_API/actions/runners" \
  --jq '.runners[] | {name, status, busy, labels: [.labels[].name]}'

echo
echo "== OS identity isolation =="
id "$LCM_CI_ACCOUNT"
echo "admin group members:"; dscl . -read /Groups/admin GroupMembership
echo "home perms:"; stat -f '%Sp %Su %Sg %N' "/Users/$LCM_CI_ACCOUNT" \
  "/Users/$LCM_CI_ACCOUNT/actions-runner/.credentials" \
  "/Users/$LCM_CI_ACCOUNT/actions-runner/.env" \
  "/Users/$LCM_CI_ACCOUNT/actions-runner-logs" 2>/dev/null || true

echo
echo "== LaunchDaemon (run with sudo for full output) =="
PLIST="/Library/LaunchDaemons/$LCM_CI_LAUNCHD_LABEL.plist"
[ -f "$PLIST" ] && stat -f '%Sp %Su %Sg %N' "$PLIST" || echo "plist missing: $PLIST"
if [ "$(id -u)" -eq 0 ]; then
  launchctl print "system/$LCM_CI_LAUNCHD_LABEL" 2>/dev/null | grep -E 'state|pid|uid|program' | head -8 || echo "daemon not printed"
else
  echo "(re-run with sudo to include launchctl print)"
fi

echo
echo "== other product runners (must be untouched) =="
ls -d /Users/sanghyun/actions-runner /Users/sanghyun/actions-runner-figuredeal 2>/dev/null || true
echo "check their status yourself via their own repos if needed; this script never modifies them"
