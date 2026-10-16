#!/bin/bash
# Read-only verification of the LCM runner install.
# Safe to run twice — prints state, mutates nothing.
#
# Checks:
#   - Repository-scoped runner registration (GitHub API)
#   - OS identity isolation (account, admin group, home perms)
#   - Bundle integrity (root-owned, manifest present)
#   - LaunchDaemon (root-owned plist, points to bundle)
#   - Log directory (root-owned parent)
#   - Other product runners (must be untouched)
#
# Run the gh section as the operator account.
# Run the launchctl section with sudo for full output.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"

BUNDLE_ROOT="/Library/Application Support/GamjaWorld/CI/lcm-production"
LOG_DIR="/var/log/gamja-ci/lcm-production"
RUNNER_WORK_DIR="/Users/$LCM_CI_ACCOUNT/actions-runner"

echo "== repository-scoped runner registration (GitHub API) =="
gh api "$LCM_CI_REPO_API/actions/runners" \
  --jq '.runners[] | {name, status, busy, labels: [.labels[].name]}'

echo
echo "== OS identity isolation =="
id "$LCM_CI_ACCOUNT"
echo "admin group members:"; dscl . -read /Groups/admin GroupMembership
echo "home perms:"; stat -f '%Sp %Su %Sg %N' "/Users/$LCM_CI_ACCOUNT" 2>/dev/null || true

echo
echo "== Bundle integrity (root-owned immutable) =="
if [ -d "$BUNDLE_ROOT" ]; then
  echo "bundle: $BUNDLE_ROOT"
  stat -f '%Sp %Su %Sg %N' "$BUNDLE_ROOT"
  if [ -f "$BUNDLE_ROOT/manifest.txt" ]; then
    echo "manifest present:"
    head -5 "$BUNDLE_ROOT/manifest.txt"
  else
    echo "warning: manifest.txt missing"
  fi
  echo "runsvc.sh:"; stat -f '%Sp %Su %Sg %N' "$BUNDLE_ROOT/runsvc.sh" 2>/dev/null || true
  echo "config.sh:"; stat -f '%Sp %Su %Sg %N' "$BUNDLE_ROOT/config.sh" 2>/dev/null || true
else
  echo "bundle missing: $BUNDLE_ROOT"
fi

echo
echo "== Runner working directory (CI-owned) =="
if [ -d "$RUNNER_WORK_DIR" ]; then
  stat -f '%Sp %Su %Sg %N' "$RUNNER_WORK_DIR" \
    "$RUNNER_WORK_DIR/.credentials" \
    "$RUNNER_WORK_DIR/.env" 2>/dev/null || true
else
  echo "working dir missing: $RUNNER_WORK_DIR"
fi

echo
echo "== Log directory (root-owned parent) =="
if [ -d "$LOG_DIR" ]; then
  stat -f '%Sp %Su %Sg %N' "$LOG_DIR"
  ls -la "$LOG_DIR" 2>/dev/null | head -5 || true
else
  echo "log dir missing: $LOG_DIR"
fi

echo
echo "== LaunchDaemon (run with sudo for full output) =="
PLIST="/Library/LaunchDaemons/$LCM_CI_LAUNCHD_LABEL.plist"
if [ -f "$PLIST" ]; then
  stat -f '%Sp %Su %Sg %N' "$PLIST"
  echo "Program (must point to bundle):"
  grep -A1 "ProgramArguments" "$PLIST" | grep string | head -1 | sed 's/^/  /'
  echo "WorkingDirectory (must be CI-owned):"
  grep -A1 "WorkingDirectory" "$PLIST" | grep string | head -1 | sed 's/^/  /'
  echo "UserName (must be CI account):"
  grep -A1 "UserName" "$PLIST" | grep string | head -1 | sed 's/^/  /'
else
  echo "plist missing: $PLIST"
fi

if [ "$(id -u)" -eq 0 ]; then
  launchctl print "system/$LCM_CI_LAUNCHD_LABEL" 2>/dev/null | grep -E 'state|pid|uid|program' | head -8 || echo "daemon not printed"
else
  echo "(re-run with sudo to include launchctl print)"
fi

echo
echo "== other product runners (must be untouched) =="
ls -d /Users/sanghyun/actions-runner /Users/sanghyun/actions-runner-figuredeal 2>/dev/null || true
echo "check their status yourself via their own repos if needed; this script never modifies them"
