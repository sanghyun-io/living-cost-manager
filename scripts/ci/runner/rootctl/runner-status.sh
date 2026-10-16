#!/bin/bash
# Read-only runner state probe — root-owned script executed AS THE CI USER
# (the CI user is the only one allowed inside the CI-owned leaf; root never
# traverses it). Prints ONLY sanitised identity fields — never secrets.
#
# Subcommands:
#   configured        exit 0 iff a completed registration exists
#   identity [name]   print agentId/agentName parsed from .runner; when a
#                     name argument is given, exit 0 iff it matches exactly
set -euo pipefail

SELF_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SELF_DIR/runner-config.env"
# shellcheck disable=SC1091
source "$SELF_DIR/lib.sh"

require_not_root
EXPECTED_UID="$(id -u "$LCM_CI_ACCOUNT")"
[ "$(id -u)" -eq "$EXPECTED_UID" ] || { echo "error: must run as $LCM_CI_ACCOUNT" >&2; exit 1; }
reject_symlink_components "$LCM_CI_APP_ROOT" || { echo "error: symlink in app root path" >&2; exit 1; }
expect_real_dir "$LCM_CI_APP_ROOT" || { echo "error: app root missing" >&2; exit 1; }

case "${1:-}" in
  configured)
    if [ -f "$LCM_CI_APP_ROOT/.credentials" ] && [ -f "$LCM_CI_APP_ROOT/.runner" ] && [ -f "$LCM_CI_APP_ROOT/.env" ]; then
      echo "configured=yes"
      exit 0
    else
      echo "configured=no"
      exit 1
    fi
    ;;
  identity)
    want_name="${2:-$LCM_CI_RUNNER_NAME}"
    if [ ! -f "$LCM_CI_APP_ROOT/.runner" ]; then
      echo "configured=no (no .runner)"
      exit 1
    fi
    json="$(cat "$LCM_CI_APP_ROOT/.runner")"
    agent_id="$(runner_json_field "$json" agentId)"
    agent_name="$(runner_json_field "$json" agentName)"
    # Never print other fields: .runner can embed the (already expired)
    # registration token and client identifiers.
    echo "agentId=${agent_id:-unknown} agentName=${agent_name:-unknown}"
    runner_identity_matches "$json" "$want_name" || {
      echo "identity mismatch: expected agentName=$want_name" >&2
      exit 1
    }
    exit 0
    ;;
  *)
    echo "usage: runner-status.sh {configured|identity [expected-name]}" >&2
    exit 2
    ;;
esac
