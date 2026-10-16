#!/bin/bash
# Register the LCM runner against sanghyun-io/living-cost-manager ONLY.
#
# Prerequisites:
#   - 01-create-account.sh has created the CI account
#   - 00-bootstrap-bundle.sh has created the root-owned bundle
#
# Token handling (P1 security):
#   - Reads token from /dev/tty (hidden prompt) — NOT argv, NOT stdin pipe,
#     NOT environment variable, NOT file. This prevents leakage via ps, logs,
#     shell history, or CI-owned config files.
#   - Token is passed to config.sh via ACTIONS_RUNNER_INPUT_TOKEN env var
#     (official runner mechanism, verified in v2.338.0 source).
#   - Token is unset immediately after use.
#   - No token value appears in args, logs, or echo output.
#
# Run as CI user (via sudo -u from the owner's sudo session):
#   sudo -u lcm-ci scripts/ci/runner/02-register-runner.sh
#
# Or, if already running as the CI user:
#   scripts/ci/runner/02-register-runner.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"

BUNDLE_ROOT="/Library/Application Support/GamjaWorld/CI/lcm-production"
RUNNER_WORK_DIR="$HOME/actions-runner"

# Must NOT run as root
if [ "$(id -u)" -eq 0 ]; then
  echo "error: do not run as root — run as $LCM_CI_ACCOUNT" >&2
  exit 1
fi

# Must run as the CI account
if [ "$(id -un)" != "$LCM_CI_ACCOUNT" ]; then
  echo "error: must run as $LCM_CI_ACCOUNT. Use: sudo -u $LCM_CI_ACCOUNT $0" >&2
  exit 1
fi

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

# Verify bundle has the required files
if [ ! -x "$BUNDLE_ROOT/config.sh" ]; then
  echo "error: bundle missing config.sh" >&2
  exit 1
fi

# Duplicate guard: refuse if already registered
if [ -e "$RUNNER_WORK_DIR/.credentials" ] || [ -e "$RUNNER_WORK_DIR/.env" ]; then
  echo "error: existing runner registration in $RUNNER_WORK_DIR — refusing duplicate" >&2
  echo "if a previous attempt was partial, run 05-remove.sh first" >&2
  exit 1
fi

# Read token from /dev/tty (hidden prompt, not argv, not stdin pipe)
if [ ! -c /dev/tty ]; then
  echo "error: /dev/tty not available — must run from an interactive terminal" >&2
  exit 1
fi

echo "paste the registration token at the hidden prompt (Ctrl-C to abort):" >&2
IFS= read -r -s -p "registration token (hidden): " ACTIONS_RUNNER_INPUT_TOKEN </dev/tty >&2
echo >&2

if [ -z "${ACTIONS_RUNNER_INPUT_TOKEN:-}" ]; then
  echo "error: no token provided" >&2
  exit 1
fi

export ACTIONS_RUNNER_INPUT_TOKEN

# Run config.sh from the CI working directory, using the bundle's config.sh.
# config.sh uses $(dirname "$0") to find its dependencies (bin/, externals/),
# so it will correctly use the bundle's binaries.
# .credentials and .env are written to the current directory (CI working dir).
cd "$RUNNER_WORK_DIR"
"$BUNDLE_ROOT/config.sh" --unattended --replace \
  --url "$LCM_CI_REPO_URL" \
  --name "$LCM_CI_RUNNER_NAME" \
  --labels "$LCM_CI_RUNNER_LABELS"

# Unset token immediately
unset ACTIONS_RUNNER_INPUT_TOKEN

# Protect credentials
chmod 600 "$RUNNER_WORK_DIR/.credentials" "$RUNNER_WORK_DIR/.env" 2>/dev/null || true

echo "registered runner $LCM_CI_RUNNER_NAME (repo-scoped, labels: $LCM_CI_RUNNER_LABELS)"
echo "next: sudo scripts/ci/runner/03-install-launchd.sh"
