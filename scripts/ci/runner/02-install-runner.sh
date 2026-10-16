#!/bin/bash
# Download the PINNED, checksum-verified official runner and register it
# repository-scoped against sanghyun-io/living-cost-manager ONLY.
#
# Run as the dedicated CI account (never as the owner uid, never as root):
#   gh api -X POST repos/sanghyun-io/living-cost-manager/actions/runners/registration-token -q .token \
#     | sudo -u lcm-ci /bin/bash /Users/sanghyun/services/living-cost-manager/scripts/ci/runner/02-install-runner.sh
# or, interactively (hidden read -rs prompt):
#   sudo -u lcm-ci /bin/bash scripts/ci/runner/02-install-runner.sh
#
# Registration token handling:
#   * the token arrives via STDIN or an ACTIONS_RUNNER_INPUT_TOKEN environment
#     variable — never as a command argument (argv is visible in ps),
#   * upstream Runner.Listener reads ACTIONS_RUNNER_INPUT_* (src/Runner.Listener/
#     CommandSettings.cs, verified in the pinned release) and masks+erases them,
#   * tokens expire in 1 hour; nothing is written to disk except runner's own
#     .credentials, which this script chmods to 0600.
# Duplicate guard: an existing workspace identity (.env/.credentials) aborts
# before download. Use 05-remove.sh for a partial-registration retry.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"

if [ "$(id -u)" -eq 0 ]; then
  echo "error: do not run as root" >&2; exit 1
fi
if [ "$(id -un)" != "$LCM_CI_ACCOUNT" ]; then
  echo "error: must run as $LCM_CI_ACCOUNT (OS isolation boundary). Use: sudo -u $LCM_CI_ACCOUNT /bin/bash $0" >&2
  exit 1
fi

RUNNER_DIR="$HOME/actions-runner"
if [ -e "$RUNNER_DIR/.credentials" ] || [ -e "$RUNNER_DIR/.env" ]; then
  echo "error: existing runner registration identity found in $RUNNER_DIR — refusing duplicate registration" >&2
  echo "if a previous attempt was partial, run 05-remove.sh first (keeps other runners untouched)" >&2
  exit 1
fi

if [ -z "${ACTIONS_RUNNER_INPUT_TOKEN:-}" ]; then
  if [ -t 0 ]; then
    read -rs "ACTIONS_RUNNER_INPUT_TOKEN?paste registration token (hidden): "
    echo >&2
  else
    IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN
  fi
fi
if [ -z "${ACTIONS_RUNNER_INPUT_TOKEN:-}" ]; then
  echo "error: no registration token provided (stdin or ACTIONS_RUNNER_INPUT_TOKEN)" >&2; exit 1
fi
export ACTIONS_RUNNER_INPUT_TOKEN

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fL --retry 3 -o "$TMP/actions-runner.tar.gz" "$LCM_CI_RUNNER_URL"
echo "$LCM_CI_RUNNER_SHA256  $TMP/actions-runner.tar.gz" | shasum -a 256 -c -
mkdir -p "$RUNNER_DIR"
tar -xzf "$TMP/actions-runner.tar.gz" -C "$RUNNER_DIR"

cd "$RUNNER_DIR"
# NOTE: no --token argument; the token is passed via ACTIONS_RUNNER_INPUT_TOKEN.
./config.sh --unattended --replace \
  --url "$LCM_CI_REPO_URL" \
  --name "$LCM_CI_RUNNER_NAME" \
  --labels "$LCM_CI_RUNNER_LABELS"
unset ACTIONS_RUNNER_INPUT_TOKEN

# Same step the official svc.sh install performs (bin/runsvc.sh is a finished
# script with no placeholders; the LaunchDaemon invokes ./runsvc.sh).
cp bin/runsvc.sh ./runsvc.sh
chmod u+x ./runsvc.sh

chmod 600 "$RUNNER_DIR/.credentials" "$RUNNER_DIR/.env" 2>/dev/null || true
echo "registered runner $LCM_CI_RUNNER_NAME (repo-scoped, labels: $LCM_CI_RUNNER_LABELS)"
echo "next: sudo scripts/ci/runner/03-install-launchd.sh"
