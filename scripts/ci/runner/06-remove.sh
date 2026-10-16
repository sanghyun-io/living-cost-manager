#!/bin/bash
# Rollback for the LCM dedicated runner ONLY (LaunchDaemon + GitHub
# registration). Account, leaf files, logs, bundle, and all other products'
# runners are preserved — nothing is auto-deleted.
#
# Usage (Owner terminal; removal token is piped on STDIN, never argv):
#   sudo -v
#   gh api -X POST repos/sanghyun-io/living-cost-manager/actions/runners/remove-token --jq .token \
#     | sudo scripts/ci/runner/06-remove.sh
#
# Ordering safety (all preconditions validated BEFORE any stop/removal):
#   1. token present + shape-valid (nothing stops before the token exists —
#      prevents a half-removal where the daemon is gone but the runner
#      cannot be deconfigured),
#   2. plist exists and references exactly our label/wrapper/UserName,
#   3. leaf entry is a CI-owned real directory (metadata under the root-owned
#      parent; CI cannot have renamed it there),
#   4. runner identity: the root-owned probe runs AS the CI uid and validates
#      .runner agentName against the fixed expected name — root trusts only
#      the exit status + printed simple fields, never treats CI JSON as code
#      or paths,
#   5. then bootout (waits for the process to actually exit; never kills by
#      name/pattern), plist removal, CI-side config.sh remove via stdin token.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run with sudo" >&2
  echo "usage: gh api ... remove-token --jq .token | sudo $0" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"
# shellcheck disable=SC1091
source "$HERE/lib/lib-runner.sh"

PARENT="$LCM_CI_PARENT"
LEAF="$LCM_CI_APP_ROOT"
PLIST="/Library/LaunchDaemons/$LCM_CI_LAUNCHD_LABEL.plist"

echo "=== precondition: removal token on stdin (read before any mutation) ==="
if [ -t 0 ]; then
  echo "error: no piped token. Use:" >&2
  echo "  gh api -X POST $LCM_CI_REPO_API/actions/runners/remove-token --jq .token | sudo $0" >&2
  exit 1
fi
IFS= read -r REMOVE_TOKEN
if ! valid_token_shape "$REMOVE_TOKEN"; then
  echo "error: removal token missing or failed shape validation — nothing stopped" >&2
  exit 1
fi
echo "token received (shape OK; value not echoed)"

echo "=== precondition: layout + ownership ==="
if ! id "$LCM_CI_ACCOUNT" >/dev/null 2>&1; then
  echo "error: account $LCM_CI_ACCOUNT missing — refusing (unexpected state; manual investigation)" >&2
  exit 1
fi
CI_UID="$(id -u "$LCM_CI_ACCOUNT")"
reject_symlink_components "$PARENT" || { echo "error: symlink in parent path — refusing" >&2; exit 1; }
expect_dir_owner_uid "$PARENT" 0 || { echo "error: parent not root-owned — refusing" >&2; exit 1; }
expect_acl_safe "$PARENT" || { echo "error: $PARENT carries allow/unparseable ACL — refusing to trust parent contents" >&2; exit 1; }
[ -x "$PARENT/deregister.sh" ] && [ ! -L "$PARENT/deregister.sh" ] && [ "$(stat -f '%u' "$PARENT/deregister.sh")" = 0 ] || {
  echo "error: root-owned deregister.sh missing — refusing" >&2; exit 1; }
[ -x "$PARENT/runner-status.sh" ] || { echo "error: runner-status.sh missing — refusing" >&2; exit 1; }
expect_acl_safe "$PARENT/deregister.sh" || { echo "error: deregister.sh ACL unsafe — refusing" >&2; exit 1; }
expect_acl_safe "$PARENT/runner-status.sh" || { echo "error: runner-status.sh ACL unsafe — refusing" >&2; exit 1; }
expect_acl_safe /Library/LaunchDaemons || { echo "error: /Library/LaunchDaemons ACL unsafe — refusing" >&2; exit 1; }

PLIST_PRESENT=0
if [ -e "$PLIST" ]; then
  [ -L "$PLIST" ] && { echo "error: plist is a symlink — refusing" >&2; exit 1; }
  if grep -q "$PARENT/run-runner.sh" "$PLIST" \
     && grep -q "<key>Label</key>" "$PLIST" \
     && grep -q "$LCM_CI_LAUNCHD_LABEL" "$PLIST" \
     && grep -q "<string>$LCM_CI_ACCOUNT</string>" "$PLIST"; then
    echo "plist references the LCM wrapper + account — OK"
    PLIST_PRESENT=1
  else
    echo "error: $PLIST does not match the LCM install — refusing to touch it" >&2
    exit 1
  fi
else
  echo "no LaunchDaemon installed"
fi

RUNNER_CONFIGURED=0
if [ -d "$LEAF" ] && [ ! -L "$LEAF" ] && expect_dir_owner_uid "$LEAF" "$CI_UID"; then
  echo "leaf present and CI-owned — OK"
else
  echo "error: leaf missing or not CI-owned — refusing (unexpected state)" >&2
  exit 1
fi

if sudo -n -u "$LCM_CI_ACCOUNT" "$PARENT/runner-status.sh" configured >/dev/null 2>&1; then
  echo "runner registration present in leaf"
  RUNNER_CONFIGURED=1
else
  echo "runner not configured (nothing to deconfigure)"
fi

if [ "$RUNNER_CONFIGURED" -eq 1 ]; then
  echo "identity check (CI-uid probe, fixed expected name):"
  if ! IDENTITY_OUT="$(sudo -n -u "$LCM_CI_ACCOUNT" "$PARENT/runner-status.sh" identity "$LCM_CI_RUNNER_NAME" 2>&1)"; then
    echo "error: .runner identity does not match $LCM_CI_RUNNER_NAME — refusing" >&2
    printf '%s\n' "$IDENTITY_OUT" | sed 's/^/  /' >&2
    REMOVE_TOKEN=""
    exit 1
  fi
  printf '%s\n' "$IDENTITY_OUT" | sed 's/^/  /'
fi

echo "=== plan ==="
[ "$PLIST_PRESENT" -eq 1 ] && echo "  1. bootout system/$LCM_CI_LAUNCHD_LABEL (wait for exit)"
[ "$RUNNER_CONFIGURED" -eq 1 ] && echo "  2. config.sh remove as $LCM_CI_ACCOUNT (token via stdin of the root-owned script)"
echo "  3. preserve: account, leaf files, logs, bundle, other product runners"

# ---- Step 1: stop our own daemon only ----
if [ "$PLIST_PRESENT" -eq 1 ]; then
  echo "=== step 1: stop LaunchDaemon ==="
  launchctl bootout "system/$LCM_CI_LAUNCHD_LABEL"
  deadline=$((SECONDS + 60))
  while [ $SECONDS -lt $deadline ]; do
    if ! launchctl print "system/$LCM_CI_LAUNCHD_LABEL" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if launchctl print "system/$LCM_CI_LAUNCHD_LABEL" >/dev/null 2>&1; then
    echo "error: daemon still present after bootout — aborting WITHOUT removing plist" >&2
    echo "investigate 'launchctl print system/$LCM_CI_LAUNCHD_LABEL'; this script never kills by name/pattern" >&2
    REMOVE_TOKEN=""
    exit 1
  fi
  rm -f "$PLIST"
  echo "daemon removed; plist deleted"
fi

# ---- Step 2: deconfigure via CI uid, token on stdin only ----
if [ "$RUNNER_CONFIGURED" -eq 1 ]; then
  echo "=== step 2: deconfigure runner ==="
  # printf is a bash builtin — it never appears in ps argv; the token goes to
  # sudo's stdin only, and deregister.sh re-validates identity as the CI uid.
  printf '%s\n' "$REMOVE_TOKEN" | sudo -u "$LCM_CI_ACCOUNT" "$PARENT/deregister.sh"
fi
REMOVE_TOKEN=""

echo "=== rollback complete ==="
echo "removed: LaunchDaemon + GitHub registration (if present)"
echo "preserved: OS account ($LCM_CI_ACCOUNT), leaf, logs, bundle public files"
echo "preserved: other product runners (never touched)"
echo
echo "full teardown is a SEPARATE, explicitly approved step:"
echo "  sudo dscl . -delete /Users/$LCM_CI_ACCOUNT && sudo dscl . -delete /Groups/$LCM_CI_ACCOUNT"
echo "  sudo rm -rf '/Users/$LCM_CI_ACCOUNT'"
echo "  sudo rm -rf '$LEAF' '$PARENT' '$LCM_CI_LOG_DIR'"
echo "(after verifying no GitHub runner entry remains: gh api $LCM_CI_REPO_API/actions/runners)"
