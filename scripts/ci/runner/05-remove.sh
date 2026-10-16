#!/bin/bash
# Rollback for the LCM dedicated runner ONLY:
#   * stops + removes the LaunchDaemon and its plist (verifies the plist is
#     ours by content before touching it),
#   * deconfigures the runner registration (removal token via stdin/env —
#     never argv), which removes the runner from GitHub,
#   * keeps: the OS account, the runner directory/files, all logs, the
#     Harudo/Figuredeal runners, and every old reference for restore.
# Restore plan = re-run 02 (fresh registration token) + 03. Nothing here
# re-enables any GitHub-hosted fallback; the removed legacy workflow stays
# removed unless the owner separately decides to restore it from git history.
#
#   sudo scripts/ci/runner/05-remove.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run with sudo" >&2; exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"

PLIST="/Library/LaunchDaemons/$LCM_CI_LAUNCHD_LABEL.plist"
RUNNER_DIR="/Users/$LCM_CI_ACCOUNT/actions-runner"

if [ -f "$PLIST" ]; then
  if grep -q "$RUNNER_DIR/runsvc.sh" "$PLIST"; then
    launchctl bootout "system/$LCM_CI_LAUNCHD_LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "LaunchDaemon $LCM_CI_LAUNCHD_LABEL disabled and removed"
  else
    echo "error: $PLIST does not reference the LCM runner path — refusing to touch it" >&2
    exit 1
  fi
else
  echo "no LaunchDaemon installed (nothing to stop)"
fi

if [ -f "$RUNNER_DIR/.credentials" ]; then
  echo "get a removal token (expires in 1h):"
  echo "  gh api -X POST $LCM_CI_REPO_API/actions/runners/remove-token -q .token"
  echo "paste it at the hidden prompt (or pipe stdin), then Ctrl-C to abort freely:"
  read -rs "REMOVE_TOKEN?removal token (hidden): "
  echo >&2
  # Token travels via stdin into the CI account's process env only — never in
  # sudo/cmd argv (ps-visible) and never on disk.
  printf '%s\n' "$REMOVE_TOKEN" | sudo -u "$LCM_CI_ACCOUNT" /bin/bash -c \
    'IFS= read -r TOK; [ -n "$TOK" ] || { echo "empty token" >&2; exit 1; }; export ACTIONS_RUNNER_INPUT_TOKEN="$TOK"; unset TOK; cd "$1" && exec ./config.sh remove --unattended --replace' _ "$RUNNER_DIR"
  REMOVE_TOKEN=""
  echo "runner deconfigured; .credentials left in place for audit until you delete it"
else
  echo "runner was never configured (skipping deconfigure)"
fi

echo
echo "rollback complete for the LCM runner only. Other runners and the OS"
echo "account were untouched. Deleting the $LCM_CI_ACCOUNT account itself is a"
echo "separate decision (dscl delete + home removal) — not performed here."
