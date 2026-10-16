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
#
# ALL future install paths (bundle parent/leaf, log dir, plist) are validated
# for absence, symlink-free canonical form, POSIX ownership AND effective ACLs
# (see lib/lib-runner.sh policy: any allow ACE or unparseable entry = reject,
# deny-only tolerated) BEFORE any dscl/mkdir mutation happens. An inherited
# ACL on /Users or the bundle ancestors blocks provisioning here instead of
# becoming a privilege escape later.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run with sudo (one-time owner authorization): sudo scripts/ci/runner/01-create-account.sh" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"
# shellcheck disable=SC1091
source "$HERE/lib/lib-runner.sh"

# Fresh-install-only: identity + every future path must be absent.
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
for p in "$LCM_CI_APP_ROOT" "$LCM_CI_PARENT/runner-config.env" "$LCM_CI_LOG_DIR/launchd.out.log" \
         "/Library/LaunchDaemons/$LCM_CI_LAUNCHD_LABEL.plist"; do
  if [ -e "$p" ] || [ -L "$p" ]; then
    echo "error: $p already exists — refusing account creation on top of a partial install" >&2
    exit 1
  fi
done

# Path preflight (canonical, symlink-free, ownership + mode + ACL) for the
# components that already exist. Missing bundle/log components are fine here;
# 02 creates them fresh and re-validates after creation (inherited ACEs).
reject_symlink_components "/Users" || { echo "error: symlink component in /Users path" >&2; exit 1; }
expect_dir_owner_uid "/Users" 0 || { echo "error: /Users not root-owned" >&2; exit 1; }
expect_dir_no_group_world_write "/Users" || { echo "error: /Users group/world writable" >&2; exit 1; }
expect_acl_safe "/Users" || {
  echo "error: /Users carries an allow/unparseable ACL entry — refusing; investigate before provisioning (this kit never modifies ACLs)" >&2
  exit 1; }

# Canonical bundle/log path components (validate existing ones only).
for chain in "$LCM_CI_GAMJAWORLD_DIR" "$LCM_CI_LOG_DIR"; do
  probe=""
  IFS='/'
  for seg in $chain; do
    [ -n "$seg" ] || { probe=""; continue; }
    probe="$probe/$seg"
    if [ -L "$probe" ]; then
      echo "error: symlink component at $probe — refusing (use canonical /private/... paths)" >&2
      exit 1
    fi
    if [ -d "$probe" ]; then
      expect_dir_owner_uid "$probe" 0 || { echo "error: $probe not root-owned" >&2; exit 1; }
      expect_dir_no_group_world_write "$probe" || { echo "error: $probe group/world writable" >&2; exit 1; }
      expect_acl_safe "$probe" || { echo "error: $probe carries allow/unparseable ACL — refusing" >&2; exit 1; }
    fi
  done
  unset IFS
done

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

# Home directory: birth mode 0700 directly (no 0755 window), umask guards
# the implicit file creations inside dscl paths (none expected).
umask 077
mkdir -m 0700 "/Users/$LCM_CI_ACCOUNT"
chown "$LCM_CI_ACCOUNT:$LCM_CI_ACCOUNT" "/Users/$LCM_CI_ACCOUNT"

# Post-conditions (fail loudly if directory services did not apply).
id "$LCM_CI_ACCOUNT" >/dev/null
[ "$(stat -f '%u' "/Users/$LCM_CI_ACCOUNT")" = "$UID_N" ]
[ "$(stat -f '%A' "/Users/$LCM_CI_ACCOUNT")" = "700" ]
expect_acl_safe "/Users/$LCM_CI_ACCOUNT" || {
  echo "PARTIAL-STATE ERROR: home created but inherited an allow/unparseable ACL." >&2
  echo "STOP: do not re-run; investigate the ACE source (no auto-delete performed)." >&2
  exit 1; }
if dscl . -read /Groups/admin GroupMembership 2>/dev/null | tr ' ' '\n' | grep -qx "$LCM_CI_ACCOUNT"; then
  echo "PARTIAL-STATE ERROR: account landed in admin group — investigate, this kit does not auto-repair" >&2
  exit 1
fi

echo "created non-admin account $LCM_CI_ACCOUNT (uid $UID_N, gid $GID, no password record, shell /usr/bin/false, home 0700 birth-mode)"
echo "verify: id $LCM_CI_ACCOUNT"
echo "next: sudo scripts/ci/runner/02-install-bundle.sh"
