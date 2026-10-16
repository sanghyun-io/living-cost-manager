#!/bin/bash
# Read-only verification of the LCM runner install. Safe to run repeatedly —
# prints state, mutates nothing. Never traverses into the CI-owned leaf with
# privileged file operations: registration/identity facts are probed by the
# root-owned runner-status.sh executing AS the CI uid (exit status + sanitised
# fields only), and the leaf is inspected only as a directory entry of the
# root-owned parent (owner/uid/mode metadata — CI cannot rename it there).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"
# shellcheck disable=SC1091
source "$HERE/lib/lib-runner.sh"

PARENT="$LCM_CI_PARENT"
LEAF="$LCM_CI_APP_ROOT"
LOG_DIR="$LCM_CI_LOG_DIR"
PLIST="/Library/LaunchDaemons/$LCM_CI_LAUNCHD_LABEL.plist"

echo "== repository-scoped runner registration (GitHub API; run as operator) =="
gh api "$LCM_CI_REPO_API/actions/runners" \
  --jq '.runners[] | {name, status, busy, labels: [.labels[].name]}' 2>/dev/null \
  || echo "(gh unavailable or no runners visible)"

echo
echo "== OS identity isolation =="
id "$LCM_CI_ACCOUNT" 2>/dev/null || echo "account missing: $LCM_CI_ACCOUNT"
echo "admin group members:"; dscl . -read /Groups/admin GroupMembership 2>/dev/null || true
if id "$LCM_CI_ACCOUNT" >/dev/null 2>&1; then
  echo "shell (must be /usr/bin/false): $(dscl . -read "/Users/$LCM_CI_ACCOUNT" UserShell 2>/dev/null || true)"
  echo "password record (must be absent): $(dscl . -read "/Users/$LCM_CI_ACCOUNT" AuthenticationAuthority 2>&1 | head -1)"
fi

echo
echo "== install parent (root-owned, immutable public files) =="
if [ -d "$PARENT" ] && [ ! -L "$PARENT" ]; then
  stat -f '%Sp %Su %Sg %N' "$PARENT"
  for f in register.sh deregister.sh runner-status.sh run-runner.sh lib.sh runner-config.env manifest.txt; do
    [ -f "$PARENT/$f" ] && [ ! -L "$PARENT/$f" ] \
      && echo "  $(stat -f '%Sp %Su %N' "$PARENT/$f")" || echo "  MISSING: $f"
  done
  if expect_acl_safe "$PARENT"; then echo "ACL on parent: SAFE (none/deny-only)"; else echo "ACL on parent: UNSAFE (allow/unparseable ACE) — investigate"; fi
  if [ -f "$PARENT/manifest.txt" ]; then
    echo "manifest pin: $(grep -m1 '^# git:' "$PARENT/manifest.txt" || true)"
    echo "public file hash verification:"
    grep -v '^#' "$PARENT/manifest.txt" | shasum -a 256 -c - 2>&1 | sed 's/^/  /'
  fi
else
  echo "parent missing: $PARENT"
fi

echo
echo "== official appRoot leaf (CI-owned; entry metadata only) =="
if [ -d "$PARENT" ] && ! [ -L "$LEAF" ]; then
  if [ -d "$LEAF" ]; then
    stat -f '%Sp %Su %Sg %N' "$LEAF"
  else
    echo "leaf missing: $LEAF"
  fi
else
  echo "cannot evaluate leaf safely (parent missing or leaf is a symlink)"
fi
if id "$LCM_CI_ACCOUNT" >/dev/null 2>&1 && [ -x "$PARENT/runner-status.sh" ]; then
  sudo -u "$LCM_CI_ACCOUNT" "$PARENT/runner-status.sh" configured 2>&1 | sed 's/^/  probe: /' || true
  sudo -u "$LCM_CI_ACCOUNT" "$PARENT/runner-status.sh" identity "$LCM_CI_RUNNER_NAME" 2>&1 | sed 's/^/  probe: /' || true
fi

echo
echo "== log dir + files (root-owned, no ACLs) =="
if [ -d "$LOG_DIR" ] && [ ! -L "$LOG_DIR" ]; then
  stat -f '%Sp %Su %Sg %N' "$LOG_DIR"
  for logfile in launchd.out.log launchd.err.log; do
    if [ -f "$LOG_DIR/$logfile" ] && [ ! -L "$LOG_DIR/$logfile" ]; then
      ls -l "$LOG_DIR/$logfile" | sed 's/^/  /'
    else
      echo "  log file missing: $logfile"
    fi
  done
else
  echo "log dir missing or symlinked: $LOG_DIR"
fi

echo
echo "== LaunchDaemon =="
if [ -f "$PLIST" ] && [ ! -L "$PLIST" ]; then
  stat -f '%Sp %Su %Sg %N' "$PLIST"
  for key in ProgramArguments WorkingDirectory UserName GroupName StandardOutPath; do
    echo "  $key: $(plutil -extract "$key" raw -o - "$PLIST" 2>/dev/null \
      || plutil -extract "$key.0" raw -o - "$PLIST" 2>/dev/null || true)"
  done
else
  echo "plist missing: $PLIST"
fi
if [ "$(id -u)" -eq 0 ]; then
  launchctl print "system/$LCM_CI_LAUNCHD_LABEL" 2>/dev/null \
    | grep -E 'state|pid|uid|program' | head -8 || echo "daemon not loaded"
else
  echo "(re-run with sudo to include launchctl print)"
fi

echo
echo "== other product runners (must be untouched; informational ls only) =="
for other in /Users/sanghyun/actions-runner /Users/sanghyun/actions-runner-figuredeal; do
  [ -d "$other" ] && echo "present: $other" || true
done
echo "this kit never reads, writes, stops, or reuses those directories"
