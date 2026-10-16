#!/bin/bash
# LaunchDaemon entry wrapper — root-owned, immutable, never re-written after
# 02-install-bundle.sh. launchd drops uid to UserName=lcm-ci (and GroupName)
# BEFORE exec'ing this wrapper, so this code runs unprivileged even though
# the file itself is root-owned. It execs the official run.sh inside the
# CI-owned app leaf only after validating the leaf's identity.
#
# Why run.sh (and not svc.sh/runsvc.sh): the v2.338.0 osx-arm64 package ships
# no svc templates (inspected 2026-10-16); bin/Runner.Listener --help lists
# `./run.sh` as the run entrypoint. run.sh restart semantics (verified in the
# shipped script):
#   - exit codes 2/3/4 (retryable / self-update) are retried internally,
#   - clean stop / non-retryable exits leave run.sh with exit status 0,
#     which the plist's KeepAlive{SuccessfulExit=false} honours by NOT
#     restarting (no crash-loop after `config.sh remove`),
#   - a stopped-but-still-configured runner is restarted by the operator with
#     `launchctl kickstart system/$LCM_CI_LAUNCHD_LABEL` (05-verify.sh shows
#     the state).
set -euo pipefail

SELF_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SELF_DIR/runner-config.env"
# shellcheck disable=SC1091
source "$SELF_DIR/lib.sh"

require_not_root
EXPECTED_UID="$(id -u "$LCM_CI_ACCOUNT")"
[ "$(id -u)" -eq "$EXPECTED_UID" ] || {
  echo "run-runner: refusing: expected uid $EXPECTED_UID ($LCM_CI_ACCOUNT), got $(id -u)" >&2
  exit 1
}

reject_symlink_components "$LCM_CI_APP_ROOT" || {
  echo "run-runner: refusing: symlink in app root path" >&2; exit 1; }
expect_real_dir "$LCM_CI_APP_ROOT" || {
  echo "run-runner: refusing: app root missing" >&2; exit 1; }
expect_dir_owner_uid "$LCM_CI_APP_ROOT" "$EXPECTED_UID" || {
  echo "run-runner: refusing: app root not owned by expected uid" >&2; exit 1; }
expect_dir_mode "$LCM_CI_APP_ROOT" 700 || {
  echo "run-runner: refusing: app root is not mode 0700" >&2; exit 1; }
expect_executable_regular_file "$LCM_CI_APP_ROOT/run.sh" || {
  echo "run-runner: refusing: run.sh missing/not executable regular file" >&2; exit 1; }
[ -f "$LCM_CI_APP_ROOT/.credentials" ] || {
  echo "run-runner: refusing: runner not configured (no .credentials)" >&2; exit 1; }

cd "$LCM_CI_APP_ROOT"
exec ./run.sh
