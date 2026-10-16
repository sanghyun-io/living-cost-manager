#!/bin/bash
# Create the dedicated NON-ADMIN macOS service account for the LCM CI runner.
# Requires sudo (owner password) — this is the one-time OS-mutation step the
# implementing agent was not permitted to perform. The account:
#   * is not in the admin group and has no sudo access,
#   * has no password record (AuthenticationAuthority unset) so interactive
#     login is impossible; launchd runs it by UserName only,
#   * has /usr/bin/false as shell, is hidden from the login window,
#   * owns a 0700 home directory that no other OS user can read.
# Never add this account to admin or other product groups.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run with sudo (one-time owner authorization): sudo scripts/ci/runner/01-create-account.sh" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"

if dscl . -read "/Users/$LCM_CI_ACCOUNT" >/dev/null 2>&1; then
  echo "account $LCM_CI_ACCOUNT already exists — refusing (no duplicate provisioning, no re-configuration)" >&2
  exit 1
fi

free_id() {
  local candidate="$1" kind="$2"
  while [ -n "$(dscl . -search "/$kind" "${3}" "$candidate" 2>/dev/null)" ]; do
    candidate=$((candidate + 1))
  done
  echo "$candidate"
}

GID="$(free_id 550 Groups PrimaryGroupID)"
UID_N="$(free_id "$GID" Users UniqueID)"

dscl . -create "/Groups/$LCM_CI_ACCOUNT"
dscl . -create "/Groups/$LCM_CI_ACCOUNT" PrimaryGroupID "$GID"
dscl . -create "/Groups/$LCM_CI_ACCOUNT" RecordName "$LCM_CI_ACCOUNT"

dscl . -create "/Users/$LCM_CI_ACCOUNT"
dscl . -create "/Users/$LCM_CI_ACCOUNT" UniqueID "$UID_N"
dscl . -create "/Users/$LCM_CI_ACCOUNT" PrimaryGroupID "$GID"
dscl . -create "/Users/$LCM_CI_ACCOUNT" RecordName "$LCM_CI_ACCOUNT"
dscl . -create "/Users/$LCM_CI_ACCOUNT" RealName "Living Cost Manager CI Runner"
dscl . -create "/Users/$LCM_CI_ACCOUNT" NFSHomeDirectory "/Users/$LCM_CI_ACCOUNT"
dscl . -create "/Users/$LCM_CI_ACCOUNT" UserShell /usr/bin/false
dscl . -create "/Users/$LCM_CI_ACCOUNT" Hidden 1

mkdir -p "/Users/$LCM_CI_ACCOUNT"
chown "$LCM_CI_ACCOUNT" "/Users/$LCM_CI_ACCOUNT"
chmod 700 "/Users/$LCM_CI_ACCOUNT"

echo "created non-admin account $LCM_CI_ACCOUNT (uid $UID_N, gid $GID, no password, shell false)"
echo "verify: id $LCM_CI_ACCOUNT  &&  dscl . -read /Groups/admin GroupMembership (must not contain $LCM_CI_ACCOUNT)"
