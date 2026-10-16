#!/bin/bash
# LCM runner registration — OWNER wrapper (run from an interactive terminal
# as the Mac Mini owner; NOT as root, NOT as CI).
#
# Flow (token never appears in argv, a file, or echoed output):
#   1. preflight (read-only) validates the installed parent/leaf and refuses
#      to request a token if state is wrong or a registration already exists,
#   2. sudo -v caches the Owner's OS password from the terminal (this kit
#      does not touch sudoers and creates no NOPASSWD entries),
#   3. the Owner's own gh CLI (operator keychain config, never copied to
#      root or CI) requests a fresh repository-scoped registration token and
#      pipes it straight into the root-owned register.sh running as lcm-ci:
#         gh api ... --jq .token | sudo -n -u lcm-ci register.sh
#      sudo's argv carries no token; register.sh reads STDIN, validates the
#      shape, and hands it to the official config.sh via the native
#      ACTIONS_RUNNER_INPUT_TOKEN environment variable, scoped to that single
#      subprocess. The token is valid for 1 hour; there is no reuse and no
#      --replace — duplicates/partial states are refused upstream of that.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"
# shellcheck disable=SC1091
source "$HERE/lib/lib-runner.sh"

if [ "$(id -u)" -eq 0 ]; then
  echo "error: run as the Owner (this wrapper invokes sudo itself), not as root" >&2
  exit 1
fi

PARENT="$LCM_CI_PARENT"

echo "== preflight (no token requested yet) =="
if ! id "$LCM_CI_ACCOUNT" >/dev/null 2>&1; then
  echo "error: account $LCM_CI_ACCOUNT missing — run 01-create-account.sh first" >&2
  exit 1
fi
for f in register.sh runner-config.env lib.sh; do
  [ -f "$PARENT/$f" ] && [ ! -L "$PARENT/$f" ] || {
    echo "error: $PARENT/$f missing or symlinked — run 02-install-bundle.sh first" >&2; exit 1; }
  [ "$(stat -f '%u' "$PARENT/$f")" = 0 ] || {
    echo "error: $PARENT/$f not root-owned — bundle integrity violation" >&2; exit 1; }
done
expect_executable_regular_file "$PARENT/register.sh" || {
  echo "error: register.sh must be a root-owned executable regular file" >&2; exit 1; }
reject_symlink_components "$PARENT" || {
  echo "error: symlink in $PARENT path" >&2; exit 1; }
expect_dir_owner_uid "$PARENT" 0 || { echo "error: parent not root-owned" >&2; exit 1; }
expect_dir_no_group_world_write "$PARENT" || {
  echo "error: parent writable by group/world" >&2; exit 1; }
# Effective ACL check (POSIX mode alone can miss inherited/allow ACEs that
# would let another principal swap parent files): deny-only or none.
expect_acl_safe "$PARENT" || {
  echo "error: $PARENT carries allow/unparseable ACL — bundle integrity unverified; investigate before registering" >&2; exit 1; }
for f in register.sh runner-config.env lib.sh run-runner.sh; do
  expect_acl_safe "$PARENT/$f" || {
    echo "error: $PARENT/$f carries allow/unparseable ACL — refusing" >&2; exit 1; }
done
# Leaf identity (stat of the leaf entry under a root-owned parent is safe:
# CI cannot rename/replace it there).
reject_symlink_components "$LCM_CI_APP_ROOT" || {
  echo "error: symlink at leaf path — refusing" >&2; exit 1; }
expect_real_dir "$LCM_CI_APP_ROOT" || {
  echo "error: leaf missing — run 02-install-bundle.sh first" >&2; exit 1; }
expect_dir_owner_uid "$LCM_CI_APP_ROOT" "$(id -u "$LCM_CI_ACCOUNT")" || {
  echo "error: leaf not owned by $LCM_CI_ACCOUNT — refusing" >&2; exit 1; }
expect_dir_mode "$LCM_CI_APP_ROOT" 700 || {
  echo "error: leaf must be mode 0700" >&2; exit 1; }

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI required for the owner-side token request" >&2
  exit 1
fi
GH_LOGIN="$(gh api user --jq .login 2>/dev/null || true)"
if [ "$GH_LOGIN" != "$LCM_CI_OWNER" ]; then
  echo "error: gh must be authenticated as $LCM_CI_OWNER (currently: ${GH_LOGIN:-unknown}) — do not copy credentials; use the operator's own gh auth" >&2
  exit 1
fi

echo "== owner authorization (terminal password for sudo -v) =="
sudo -v

# Duplicate guard WITHOUT reading file contents as root: the root-owned
# status probe runs as the CI uid and reports only exit status. (Run after
# sudo -v so a sudo failure cannot be mistaken for "not configured".)
if sudo -n -u "$LCM_CI_ACCOUNT" "$PARENT/runner-status.sh" configured >/dev/null 2>&1; then
  echo "error: runner already configured in the leaf — refusing (use 06-remove.sh to roll back first)" >&2
  exit 1
fi

echo "== requesting fresh repo-scoped registration token and piping to register.sh (stdin only) =="
gh api -X POST "$LCM_CI_REPO_API/actions/runners/registration-token" --jq .token \
  | sudo -n -u "$LCM_CI_ACCOUNT" "$PARENT/register.sh"

echo "registration completed. next: sudo scripts/ci/runner/04-install-launchd.sh"
