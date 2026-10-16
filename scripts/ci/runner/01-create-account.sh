#!/bin/bash
# Create the dedicated NON-ADMIN macOS service account for the LCM CI runner.
# One-time fresh-install step run with sudo (Owner terminal). The account:
#   * unique primary group (allocated >=550, never staff/20 or admin/80),
#   * not in the admin group, no sudo configuration is created for it,
#   * no password record (AuthenticationAuthority unset) + shell /usr/bin/false
#     → interactive login disabled; launchd runs it by UserName only,
#   * hidden from the login window,
#   * fresh 0700 home under the root-owned /Users parent — created here while
#     no CI process exists yet; root never touches the home or the CI-owned
#     trees afterwards.
#
# Fresh-install semantics: if the account OR any of its paths already exists
# unexpectedly, this script FAILS without mutation. There is deliberately no
# "repair" path — re-creating or re-chowning an existing identity is exactly
# the TOCTOU/repair hazard this kit avoids. 06-remove.sh preserves the
# account; full teardown is a separate manual, approved step.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run with sudo (one-time owner authorization): sudo scripts/ci/runner/01-create-account.sh" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"

if dscl . -read "/Users/$LCM_CI_ACCOUNT" >/dev/null 2>&1; then
  echo "error: account $LCM_CI_ACCOUNT already exists — refusing (fresh-install-only, no re-configuration)" >&2
  exit 1
fi
if dscl . -read "/Groups/$LCM_CI_ACCOUNT" >/dev/null 2>&1; then
  echo "error: group $LCM_CI_ACCOUNT already exists — refusing" >&2
  exit 1
fi
if [ -e "/Users/$LCM_CI_ACCOUNT" ] || [ -L "/Users/$LCM_CI_ACCOUNT" ]; then
  echo "error: /Users/$LCM_CI_ACCOUNT already exists — refusing (unexpected state, no mutation)" >&2
  exit 1
fi
# Unexpected pre-existing install paths mean a previous (partial) install.
for p in "$LCM_CI_APP_ROOT" "$LCM_CI_PARENT/runner-config.env" "$LCM_CI_LOG_DIR/launchd.out.log"; do
  if [ -e "$p" ] || [ -L "$p" ]; then
    echo "error: $p already exists — refusing account creation on top of a partial install" >&2
    exit 1
  fi
done

# /Users itself must be the root-owned real directory (it is on macOS).
reject_symlink_components "/Users" || { echo "error: symlink in /Users path" >&2; exit 1; }

free_gid() {
  local candidate=550
  while dscl . -search /Groups gid "$candidate" >/dev/null 2>&1 || \
        dscl . -search /Users UniqueID "$candidate" >/dev/null 2>&1; do
    candidate=$((candidate + 1))
  done
  echo "$candidate"
}

GID="$(free_gid)"
if [ "$GID" -eq 20 ] || [ "$GID" -eq 80 ]; then
  echo "error: allocated gid $GID collides with staff/admin — aborting" >&2
  exit 1
fi
UID_N="$GID"   # unique uid == gid keeps the dedicated identity obvious

dscl . -create "/Groups/$LCM_CI_ACCOUNT"
dscl . -create "/Groups/$LCM_CI_ACCOUNT" RecordName "$LCM_CI_ACCOUNT"
dscl . -create "/Groups/$LCM_CI_ACCOUNT" PrimaryGroupID "$GID"

dscl . -create "/Users/$LCM_CI_ACCOUNT"
dscl . -create "/Users/$LCM_CI_ACCOUNT" RecordName "$LCM_CI_ACCOUNT"
dscl . -create "/Users/$LCM_CI_ACCOUNT" UniqueID "$UID_N"
dscl . -create "/Users/$LCM_CI_ACCOUNT" PrimaryGroupID "$GID"
dscl . -create "/Users/$LCM_CI_ACCOUNT" RealName "Living Cost Manager CI Runner"
dscl . -create "/Users/$LCM_CI_ACCOUNT" NFSHomeDirectory "/Users/$LCM_CI_ACCOUNT"
dscl . -create "/Users/$LCM_CI_ACCOUNT" UserShell /usr/bin/false
dscl . -create "/Users/$LCM_CI_ACCOUNT" Hidden 1

mkdir "/Users/$LCM_CI_ACCOUNT"
chown "$LCM_CI_ACCOUNT:$LCM_CI_ACCOUNT" "/Users/$LCM_CI_ACCOUNT"
chmod 700 "/Users/$LCM_CI_ACCOUNT"

# Post-conditions (fail loudly if directory services did not apply).
id "$LCM_CI_ACCOUNT" >/dev/null
[ "$(stat -f '%u' "/Users/$LCM_CI_ACCOUNT")" = "$UID_N" ]
[ "$(stat -f '%A' "/Users/$LCM_CI_ACCOUNT")" = "700" ]
if dscl . -read /Groups/admin GroupMembership 2>/dev/null | tr ' ' '\n' | grep -qx "$LCM_CI_ACCOUNT"; then
  echo "error: account landed in admin group — deleting nothing, STOP and investigate" >&2
  exit 1
fi

echo "created non-admin account $LCM_CI_ACCOUNT (uid $UID_N, gid $GID, no password record, shell /usr/bin/false, home 0700)"
echo "verify: id $LCM_CI_ACCOUNT"
echo "next: sudo scripts/ci/runner/02-install-bundle.sh"
