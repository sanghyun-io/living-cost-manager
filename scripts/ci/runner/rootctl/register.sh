#!/bin/bash
# LCM CI runner registration — root-owned immutable control script.
#
# Executed AS THE CI USER, invoked by the owner wrapper 03-register-runner.sh:
#   gh api -X POST $LCM_CI_REPO_API/actions/runners/registration-token --jq .token \
#     | sudo -n -u lcm-ci '/Library/Application Support/GamjaWorld/CI/lcm-production/register.sh'
#
# Token handling:
#   - read from STDIN ONLY (a pipe from the owner's own gh CLI). Not argv,
#     not a file, never echoed. sudo command argv contains no token.
#   - handed to the official config.sh via ACTIONS_RUNNER_INPUT_TOKEN, the
#     native environment mechanism (verified present in v2.338.0
#     bin/Runner.Listener.dll; config.sh/run.sh refuse to run as root).
#   - the assignment is scoped to the single config.sh invocation.
#
# Fixed, repo-scoped constants (URL/name/labels) come from the root-owned
# runner-config.env next to this script — never from argv. NO --replace:
# duplicate/partial registration is refused outright.
set -euo pipefail

SELF_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SELF_DIR/runner-config.env"
# shellcheck disable=SC1091
source "$SELF_DIR/lib.sh"

PREFLIGHT=0
case "${1:-}" in
  "") ;;
  --preflight) PREFLIGHT=1 ;;
  *) echo "usage: register.sh [--preflight]  (token on stdin)" >&2; exit 2 ;;
esac

require_not_root

EXPECTED_UID="$(id -u "$LCM_CI_ACCOUNT")"
if [ "$(id -u)" -ne "$EXPECTED_UID" ]; then
  echo "error: must run as $LCM_CI_ACCOUNT (uid $EXPECTED_UID), got uid $(id -u)" >&2
  exit 1
fi

# Leaf must be the official appRoot: real directory, CI-owned 0700, reached
# through a symlink-free path, with the official entrypoints executable.
reject_symlink_components "$LCM_CI_APP_ROOT" || {
  echo "error: symlink in $LCM_CI_APP_ROOT path — refusing" >&2; exit 1; }
expect_real_dir "$LCM_CI_APP_ROOT" || {
  echo "error: app root missing or not a real directory: $LCM_CI_APP_ROOT (run 02 as root)" >&2; exit 1; }
expect_dir_owner_uid "$LCM_CI_APP_ROOT" "$EXPECTED_UID" || {
  echo "error: app root is not owned by $LCM_CI_ACCOUNT — refusing" >&2; exit 1; }
expect_dir_mode "$LCM_CI_APP_ROOT" 700 || {
  echo "error: app root must be mode 0700 (found $(stat -f '%A' "$LCM_CI_APP_ROOT"))" >&2; exit 1; }
expect_executable_regular_file "$LCM_CI_APP_ROOT/config.sh" || {
  echo "error: $LCM_CI_APP_ROOT/config.sh missing/not an executable regular file" >&2; exit 1; }
expect_executable_regular_file "$LCM_CI_APP_ROOT/bin/Runner.Listener" || {
  echo "error: $LCM_CI_APP_ROOT/bin/Runner.Listener missing/not an executable regular file" >&2; exit 1; }

# Duplicate / partial-state guard (official appRoot keeps .credentials/.env/
# .runner next to the binaries).
for existing in .credentials .env .runner; do
  if [ -e "$LCM_CI_APP_ROOT/$existing" ] || [ -L "$LCM_CI_APP_ROOT/$existing" ]; then
    echo "error: existing registration or partial state ($existing) in the app root — refusing duplicate registration" >&2
    echo "if a previous attempt was partial, run 06-remove.sh (removal token) or manual teardown first" >&2
    exit 1
  fi
done

# Read the token from stdin only. An interactive tty here means nobody piped
# a token — fail closed instead of reading a password prompt from the terminal.
if [ -t 0 ]; then
  echo "error: pipe the registration token via stdin (see 03-register-runner.sh)" >&2
  exit 1
fi
IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN
if ! valid_token_shape "$ACTIONS_RUNNER_INPUT_TOKEN"; then
  # Do not print the value; only the reason class.
  if [ -z "$ACTIONS_RUNNER_INPUT_TOKEN" ]; then
    echo "error: empty token on stdin" >&2
  else
    echo "error: token failed shape validation (length/charset) — wrong paste or corrupted stream" >&2
  fi
  exit 1
fi

if [ "$PREFLIGHT" -eq 1 ]; then
  echo "preflight OK: app root, uid, entrypoints, duplicate guard, token shape all pass"
  exit 0
fi

# Official configure from the appRoot (config.sh cd's to its own dir; all
# state files land inside the same CI-owned leaf — verified semantics of
# v2.338.0). Repository scoping is enforced by the token itself: a
# repo registration token cannot register elsewhere.
cd "$LCM_CI_APP_ROOT"
ACTIONS_RUNNER_INPUT_TOKEN="$ACTIONS_RUNNER_INPUT_TOKEN" ./config.sh \
  --unattended \
  --url "$LCM_CI_REPO_URL" \
  --name "$LCM_CI_RUNNER_NAME" \
  --labels "$LCM_CI_RUNNER_LABELS"
unset ACTIONS_RUNNER_INPUT_TOKEN

for created in .credentials .runner; do
  [ -e "$LCM_CI_APP_ROOT/$created" ] || {
    echo "error: config.sh exited without creating $created — treat as partial, run 06-remove flow before retry" >&2
    exit 1; }
done
chmod 600 "$LCM_CI_APP_ROOT/.credentials" 2>/dev/null || true

echo "registered $LCM_CI_RUNNER_NAME (repo-scoped to $LCM_CI_REPO_URL, labels: $LCM_CI_RUNNER_LABELS, no --replace)"
echo "next: sudo scripts/ci/runner/04-install-launchd.sh"
