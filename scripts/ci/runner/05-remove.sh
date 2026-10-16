#!/bin/bash
# Rollback for the LCM dedicated runner ONLY.
#
# Safety: validates ALL preconditions BEFORE stopping/removing anything.
# This prevents half-removal where the daemon is stopped but the runner
# can't be deconfigured (e.g., no removal token available).
#
# What this removes:
#   * LaunchDaemon plist + stops the service (validates plist content first)
#   * Runner registration (removal token via /dev/tty — never argv)
#
# What this preserves (unless you explicitly delete):
#   * The OS account (lcm-ci)
#   * The runner working directory and files
#   * All logs
#   * The root-owned bundle
#   * Harudo/Figuredeal runners (never touched)
#
# Usage:
#   sudo scripts/ci/runner/05-remove.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run with sudo" >&2; exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"

BUNDLE_ROOT="/Library/Application Support/GamjaWorld/CI/lcm-production"
PLIST="/Library/LaunchDaemons/$LCM_CI_LAUNCHD_LABEL.plist"
RUNNER_WORK_DIR="/Library/Application Support/GamjaWorld/CI/lcm-runner/working"

echo "=== Precondition validation (read-only, no mutations) ==="

# Validate plist exists and references our bundle (not some other daemon)
PLIST_VALID=0
if [ -f "$PLIST" ]; then
  if grep -q "$BUNDLE_ROOT/runsvc.sh" "$PLIST"; then
    echo "✓ plist found and references LCM bundle"
    PLIST_VALID=1
  else
    echo "✗ plist exists but does not reference LCM bundle — refusing to touch it" >&2
    exit 1
  fi
else
  echo "· no LaunchDaemon installed (nothing to stop)"
fi

# Validate runner registration
RUNNER_REGISTERED=0
if [ -f "$RUNNER_WORK_DIR/.credentials" ]; then
  echo "✓ runner registration found in $RUNNER_WORK_DIR"
  RUNNER_REGISTERED=1
else
  echo "· runner was never configured (nothing to deconfigure)"
fi

# Validate bundle exists
if [ -d "$BUNDLE_ROOT" ]; then
  echo "✓ bundle exists at $BUNDLE_ROOT"
else
  echo "· bundle not found (may have been manually removed)"
fi

# Verify runner identity via GitHub API (if gh is available and registered)
if [ "$RUNNER_REGISTERED" -eq 1 ] && command -v gh >/dev/null 2>&1; then
  echo "checking runner identity via GitHub API..."
  RUNNER_INFO="$(gh api "$LCM_CI_REPO_API/actions/runners" --jq ".runners[] | select(.name==\"$LCM_CI_RUNNER_NAME\") | {name, id, status, busy}" 2>/dev/null || true)"
  if [ -n "$RUNNER_INFO" ]; then
    echo "✓ runner found in GitHub:"
    echo "$RUNNER_INFO" | sed 's/^/  /'
  else
    echo "· runner not found in GitHub (may have been removed already)"
  fi
fi

echo ""
echo "=== Rollback plan ==="
if [ "$PLIST_VALID" -eq 1 ]; then
  echo "  1. Stop + remove LaunchDaemon $LCM_CI_LAUNCHD_LABEL"
fi
if [ "$RUNNER_REGISTERED" -eq 1 ]; then
  echo "  2. Deconfigure runner (requires removal token)"
fi
echo "  3. Preserve: OS account, working dir, logs, bundle, other runners"
echo ""

if [ "$PLIST_VALID" -eq 0 ] && [ "$RUNNER_REGISTERED" -eq 0 ]; then
  echo "nothing to remove — all clean"
  exit 0
fi

# Confirm before proceeding
read -r -p "proceed with rollback? [y/N] " CONFIRM </dev/tty
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "aborted"
  exit 0
fi

echo ""
echo "=== Step 1: Stop LaunchDaemon ==="
if [ "$PLIST_VALID" -eq 1 ]; then
  launchctl bootout "system/$LCM_CI_LAUNCHD_LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ LaunchDaemon disabled and plist removed"
fi

echo ""
echo "=== Step 2: Deconfigure runner ==="
if [ "$RUNNER_REGISTERED" -eq 1 ]; then
  if [ ! -x "$BUNDLE_ROOT/config.sh" ]; then
    echo "error: bundle missing config.sh — cannot deconfigure" >&2
    echo "the runner is still registered in GitHub. Remove it manually:" >&2
    echo "  gh api -X DELETE $LCM_CI_REPO_API/actions/runners/<RUNNER_ID>" >&2
    exit 1
  fi

  echo "get a removal token (expires in 1h):"
  echo "  gh api -X POST $LCM_CI_REPO_API/actions/runners/remove-token -q .token"
  echo ""

  # Read token from /dev/tty (hidden, not argv)
  if [ ! -c /dev/tty ]; then
    echo "error: /dev/tty not available" >&2
    exit 1
  fi

  IFS= read -r -s -p "removal token (hidden, Ctrl-C to abort): " REMOVE_TOKEN </dev/tty
  echo >&2

  if [ -z "${REMOVE_TOKEN:-}" ]; then
    echo "error: no token provided" >&2
    exit 1
  fi

  # Pass token to CI user's config.sh remove via env (not argv)
  # config.sh reads ACTIONS_RUNNER_INPUT_TOKEN and masks/erases it
  sudo -u "$LCM_CI_ACCOUNT" env "ACTIONS_RUNNER_INPUT_TOKEN=$REMOVE_TOKEN" \
    "$BUNDLE_ROOT/config.sh" remove --unattended

  # Clear token from this shell
  REMOVE_TOKEN=""
  unset REMOVE_TOKEN

  echo "✓ runner deconfigured"
  echo "  .credentials left in place for audit (delete manually if needed)"
fi

echo ""
echo "=== Rollback complete ==="
echo "removed: LaunchDaemon + runner registration"
echo "preserved: OS account ($LCM_CI_ACCOUNT), working dir, logs, bundle"
echo "preserved: Harudo/Figuredeal runners (untouched)"
echo ""
echo "to fully delete (requires separate approval):"
echo "  sudo dscl . -delete /Users/$LCM_CI_ACCOUNT"
echo "  sudo dscl . -delete /Groups/$LCM_CI_ACCOUNT"
echo "  sudo rm -rf $RUNNER_WORK_DIR"
echo "  sudo rm -rf $BUNDLE_ROOT"
echo "  sudo rm -rf /var/log/gamja-ci/lcm-production"
