#!/bin/bash
# Root-owned immutable installer bundle builder for LCM CI runner.
#
# Architecture (P1 root symlink fix):
#   - Bundle at /Library/Application Support/GamjaWorld/CI/lcm-production/
#     contains runner binaries (root-owned, CI-readable, immutable)
#   - CI working dir at /Users/lcm-ci/actions-runner/ (CI-owned, writable)
#     holds .credentials, .env, _work, _logs
#   - Plist points to bundle's runsvc.sh (root-owned), WorkingDirectory is CI's dir
#   - Logs at /var/log/gamja-ci/lcm-production/ (root-owned parent, CI-writable files)
#
# This prevents TOCTOU: CI user cannot modify binaries that root's launchd executes.
#
# Usage:
#   sudo scripts/ci/runner/00-bootstrap-bundle.sh
#
# Token input: reads from /dev/tty (not argv, not stdin pipe) to prevent leakage.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run with sudo (one-time owner authorization)" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"

BUNDLE_ROOT="/Library/Application Support/GamjaWorld/CI/lcm-production"
LOG_ROOT="/var/log/gamja-ci/lcm-production"
CI_HOME="/Users/$LCM_CI_ACCOUNT"
RUNNER_WORK_DIR="$CI_HOME/actions-runner"

# Verify CI account exists and is non-admin
if ! id "$LCM_CI_ACCOUNT" >/dev/null 2>&1; then
  echo "error: CI account $LCM_CI_ACCOUNT does not exist. Run 01-create-account.sh first." >&2
  exit 1
fi

if dscl . -read /Groups/admin GroupMembership 2>/dev/null | grep -q "\\b$LCM_CI_ACCOUNT\\b"; then
  echo "error: $LCM_CI_ACCOUNT is in admin group — refusing (security boundary violation)" >&2
  exit 1
fi

# Verify CI account home is 0700 and owned by CI user
if [ ! -d "$CI_HOME" ]; then
  echo "error: CI home $CI_HOME does not exist" >&2
  exit 1
fi

HOME_PERMS="$(stat -f '%Sp' "$CI_HOME")"
HOME_OWNER="$(stat -f '%Su' "$CI_HOME")"
if [ "$HOME_PERMS" != "drwx------" ] || [ "$HOME_OWNER" != "$LCM_CI_ACCOUNT" ]; then
  echo "error: CI home has wrong permissions ($HOME_PERMS) or owner ($HOME_OWNER); expected drwx------ $LCM_CI_ACCOUNT" >&2
  exit 1
fi

# Verify ancestor directories are root-owned (prevent CI from creating fake parents)
for ancestor in "/Library/Application Support/GamjaWorld" "/Library/Application Support/GamjaWorld/CI"; do
  if [ -e "$ancestor" ]; then
    ANCESTOR_OWNER="$(stat -f '%Su' "$ancestor")"
    if [ "$ANCESTOR_OWNER" != "root" ]; then
      echo "error: ancestor $ancestor is owned by $ANCESTOR_OWNER, not root" >&2
      exit 1
    fi
  fi
done

# Create bundle root with root-owned ancestors
mkdir -p "$(dirname "$BUNDLE_ROOT")"
chown root:wheel "$(dirname "$BUNDLE_ROOT")"
chmod 0755 "$(dirname "$BUNDLE_ROOT")"

mkdir -p "$BUNDLE_ROOT"
chown root:wheel "$BUNDLE_ROOT"
chmod 0755 "$BUNDLE_ROOT"

# Create log root (root-owned parent, CI can write files via ACL)
mkdir -p "$(dirname "$LOG_ROOT")"
chown root:wheel "$(dirname "$LOG_ROOT")"
chmod 0755 "$(dirname "$LOG_ROOT")"

mkdir -p "$LOG_ROOT"
chown root:wheel "$LOG_ROOT"
chmod 0755 "$LOG_ROOT"

# Download runner tarball to root-owned temp dir (0700, not CI-writable)
STAGING_DIR="$(mktemp -d -t lcm-ci-runner-staging.XXXXXX)"
trap 'rm -rf "$STAGING_DIR"' EXIT
chmod 0700 "$STAGING_DIR"
chown root:wheel "$STAGING_DIR"

echo "downloading runner $LCM_CI_RUNNER_VERSION to staging area..."
curl -fL --retry 3 -o "$STAGING_DIR/actions-runner.tar.gz" "$LCM_CI_RUNNER_URL"

# Verify SHA-256 before extracting
echo "verifying SHA-256..."
echo "$LCM_CI_RUNNER_SHA256  $STAGING_DIR/actions-runner.tar.gz" | shasum -a 256 -c -

# Extract to staging
mkdir -p "$STAGING_DIR/runner"
tar -xzf "$STAGING_DIR/actions-runner.tar.gz" -C "$STAGING_DIR/runner"

# Copy ALL runner files to bundle (root-owned, CI-readable)
# This includes bin/, externals/, config.sh, runsvc.sh, etc.
# We do NOT copy .credentials, .env, _work, _logs (those go in CI working dir)
echo "installing runner to bundle..."
for item in bin externals config.sh config.sh.map runsvc.sh; do
  if [ -e "$STAGING_DIR/runner/$item" ]; then
    if [ -d "$STAGING_DIR/runner/$item" ]; then
      cp -R "$STAGING_DIR/runner/$item" "$BUNDLE_ROOT/"
    else
      cp "$STAGING_DIR/runner/$item" "$BUNDLE_ROOT/"
    fi
  fi
done

# Set ownership and permissions: root-owned, CI-readable
chown -R root:wheel "$BUNDLE_ROOT"
find "$BUNDLE_ROOT" -type d -exec chmod 0755 {} \;
find "$BUNDLE_ROOT" -type f -exec chmod 0644 {} \;
# Make scripts executable
chmod 0755 "$BUNDLE_ROOT/config.sh" "$BUNDLE_ROOT/runsvc.sh"
find "$BUNDLE_ROOT/bin" -type f -name "*.sh" -exec chmod 0755 {} \;

# Create runner working directory in CI home (CI-owned, writable)
mkdir -p "$RUNNER_WORK_DIR"
chown "$LCM_CI_ACCOUNT" "$RUNNER_WORK_DIR"
chmod 0700 "$RUNNER_WORK_DIR"

# Set ACL so CI user can write log files to root-owned log dir
chmod +a "user:$LCM_CI_ACCOUNT allow write,add_file,writeextattr,append" "$LOG_ROOT" 2>/dev/null || true

# Generate manifest with file hashes
echo "generating manifest..."
MANIFEST="$BUNDLE_ROOT/manifest.txt"
{
  echo "# LCM CI runner bundle manifest"
  echo "# Commit: $(git -C "$HERE" rev-parse HEAD 2>/dev/null || echo 'unknown')"
  echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# Runner version: $LCM_CI_RUNNER_VERSION"
  echo "# Runner SHA-256: $LCM_CI_RUNNER_SHA256"
  echo "#"
  find "$BUNDLE_ROOT" -type f ! -name manifest.txt -exec shasum -a 256 {} \;
} > "$MANIFEST"
chown root:wheel "$MANIFEST"
chmod 0644 "$MANIFEST"

echo ""
echo "bundle created at $BUNDLE_ROOT"
echo "manifest: $MANIFEST"
echo "working dir: $RUNNER_WORK_DIR"
echo "log dir: $LOG_ROOT"
echo ""
echo "next steps:"
echo "  1. Register runner: sudo scripts/ci/runner/02-register-runner.sh"
echo "  2. Install LaunchDaemon: sudo scripts/ci/runner/03-install-launchd.sh"
echo "  3. Verify: sudo scripts/ci/runner/04-verify.sh"
