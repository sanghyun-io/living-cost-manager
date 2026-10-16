#!/bin/bash
# LCM CI runner de-registration — root-owned immutable control script.
#
# Executed AS THE CI USER by 06-remove.sh after the LaunchDaemon is stopped:
#   removal token is piped to this script's STDIN (never argv, never echoed).
#
# Preconditions (ALL validated before touching anything):
#   - running as the CI uid, app root intact (real dir, CI-owned 0700,
#     symlink-free path),
#   - official config.sh + Runner.Listener present and executable,
#   - a completed registration exists (.credentials AND .runner),
#   - .runner agentName matches the fixed expected name. The JSON content is
#     CI-owned and thus untrusted: it is only compared to constants and never
#     used as a path (validated-simple-fields rule).
set -euo pipefail

SELF_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SELF_DIR/runner-config.env"
# shellcheck disable=SC1091
source "$SELF_DIR/lib.sh"

require_not_root
EXPECTED_UID="$(id -u "$LCM_CI_ACCOUNT")"
[ "$(id -u)" -eq "$EXPECTED_UID" ] || { echo "error: must run as $LCM_CI_ACCOUNT" >&2; exit 1; }

reject_symlink_components "$LCM_CI_APP_ROOT" || {
  echo "error: symlink in app root path — refusing" >&2; exit 1; }
expect_real_dir "$LCM_CI_APP_ROOT" || { echo "error: app root missing" >&2; exit 1; }
expect_dir_owner_uid "$LCM_CI_APP_ROOT" "$EXPECTED_UID" || {
  echo "error: app root not owned by $LCM_CI_ACCOUNT" >&2; exit 1; }
expect_dir_mode "$LCM_CI_APP_ROOT" 700 || {
  echo "error: app root must be mode 0700" >&2; exit 1; }
expect_executable_regular_file "$LCM_CI_APP_ROOT/config.sh" || {
  echo "error: official config.sh missing" >&2; exit 1; }

if [ ! -e "$LCM_CI_APP_ROOT/.credentials" ] || [ ! -e "$LCM_CI_APP_ROOT/.runner" ]; then
  echo "error: no completed registration in the app root (nothing to deconfigure; if partial, tear down manually)" >&2
  exit 1
fi
# plutil-based strict JSON parse of the two fixed fields; file path (opened by
# this CI-uid process), values compared to constants only — never used as paths.
runner_identity_matches "$LCM_CI_APP_ROOT/.runner" "$LCM_CI_RUNNER_NAME" || {
  echo "error: .runner agentName/agentId invalid or does not match expected identity — refusing" >&2
  exit 1
}

if [ -t 0 ]; then
  echo "error: pipe the removal token via stdin (see 06-remove.sh)" >&2
  exit 1
fi
IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN
valid_token_shape "$ACTIONS_RUNNER_INPUT_TOKEN" || {
  echo "error: removal token missing or failed shape validation" >&2; exit 1; }

cd "$LCM_CI_APP_ROOT"
ACTIONS_RUNNER_INPUT_TOKEN="$ACTIONS_RUNNER_INPUT_TOKEN" ./config.sh remove --unattended
unset ACTIONS_RUNNER_INPUT_TOKEN

if [ -e "$LCM_CI_APP_ROOT/.credentials" ]; then
  echo "warning: config.sh remove finished but .credentials still exists — inspect before restarting any service" >&2
  exit 1
fi
echo "deconfigured $LCM_CI_RUNNER_NAME from $LCM_CI_REPO_URL (account, files, logs preserved)"
