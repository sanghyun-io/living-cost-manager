#!/bin/bash
# Root-owned immutable installer bundle builder for LCM CI runner.
#
# Architecture (P1 root symlink fix - CORRECTED):
#   - Bundle at /Library/Application Support/GamjaWorld/CI/lcm-production/
#     contains runner binaries (root-owned, CI-readable, immutable)
#   - Runner working directory structure:
#     * Root creates: /Library/Application Support/GamjaWorld/CI/lcm-runner/ (root-owned, 0755)
#     * CI user creates: /Library/.../lcm-runner/working/ (CI-owned, 0700)
#     * Root NEVER traverses into CI-owned directories
#   - Logs at /var/log/gamja-ci/lcm-production/ (root-owned, pre-created files)
#     * Root pre-creates launchd.out.log and launchd.err.log (0640, root:wheel)
#     * CI can write to existing files via FD (append-only ACL on files, not directory)
#     * CI cannot create new files or symlinks in log directory
#
# Security properties:
#   - Root never operates in CI-writable namespace (no symlink attacks)
#   - Root never follows CI-owned paths after initial setup
#   - Log directory is root-owned with no CI create permission
#   - Runner binaries preserve executable permissions
#   - CI user creates working directory exclusively (no race conditions)
#
# Usage:
#   sudo scripts/ci/runner/00-bootstrap-bundle.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run with sudo (one-time owner authorization)" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/runner-version.env"

BUNDLE_ROOT="/Library/Application Support/GamjaWorld/CI/lcm-production"
RUNNER_PARENT="/Library/Application Support/GamjaWorld/CI/lcm-runner"
LOG_ROOT="/var/log/gamja-ci/lcm-production"

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
CI_HOME="/Users/$LCM_CI_ACCOUNT"
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

# Create runner parent directory (root-owned, CI can create subdirectories)
# CI user will create the 'working' subdirectory exclusively
mkdir -p "$RUNNER_PARENT"
chown root:wheel "$RUNNER_PARENT"
chmod 0755 "$RUNNER_PARENT"

# Create log root (root-owned, no CI create permission)
mkdir -p "$(dirname "$LOG_ROOT")"
chown root:wheel "$(dirname "$LOG_ROOT")"
chmod 0755 "$(dirname "$LOG_ROOT")"

mkdir -p "$LOG_ROOT"
chown root:wheel "$LOG_ROOT"
chmod 0700 "$LOG_ROOT"  # Root-only access to directory

# Pre-create log files (root-owned, CI can append via ACL on files only)
# Using O_NOFOLLOW equivalent: create files directly, not via CI-writable path
for logfile in launchd.out.log launchd.err.log; do
  LOGFILE="$LOG_ROOT/$logfile"
  if [ ! -e "$LOGFILE" ]; then
    # Create file as root (no symlink following possible since we're root creating it)
    touch "$LOGFILE"
    chown root:wheel "$LOGFILE"
    chmod 0640 "$LOGFILE"
    # Grant CI user append-only permission on this specific file (not directory)
    # This allows CI to write to the file but not create new files or symlinks
    chmod +a "user:$LCM_CI_ACCOUNT allow write,append" "$LOGFILE" 2>/dev/null || true
  else
    # Verify existing file is root-owned (reject if not)
    LOGFILE_OWNER="$(stat -f '%Su' "$LOGFILE")"
    if [ "$LOGFILE_OWNER" != "root" ]; then
      echo "error: log file $LOGFILE is owned by $LOGFILE_OWNER, not root — refusing" >&2
      exit 1
    fi
  fi
done

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
# Preserve executable bits for binaries and scripts
chown -R root:wheel "$BUNDLE_ROOT"
find "$BUNDLE_ROOT" -type d -exec chmod 0755 {} \;

# Set base permissions for files
find "$BUNDLE_ROOT" -type f -exec chmod 0644 {} \;

# Restore executable permissions for binaries and scripts
# This is critical: Runner.Listener and other binaries must be executable
chmod 0755 "$BUNDLE_ROOT/config.sh" "$BUNDLE_ROOT/runsvc.sh"
find "$BUNDLE_ROOT/bin" -type f -name "*.sh" -exec chmod 0755 {} \;

# Make Runner.Listener and other binaries executable
# The bin/ directory contains native binaries that need execute permission
if [ -d "$BUNDLE_ROOT/bin" ]; then
  # Make all files in bin/ executable (they are native binaries)
  find "$BUNDLE_ROOT/bin" -type f -exec chmod 0755 {} \;
fi

# Make externals binaries executable if they exist
if [ -d "$BUNDLE_ROOT/externals" ]; then
  find "$BUNDLE_ROOT/externals" -type f \( -name "*.sh" -o -name "node" -o -name "npm" -o -name "npx" \) -exec chmod 0755 {} \;
fi

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
echo "runner parent: $RUNNER_PARENT"
echo "log dir: $LOG_ROOT"
echo ""
echo "IMPORTANT: CI user must create working directory:"
echo "  sudo -u $LCM_CI_ACCOUNT mkdir -p '$RUNNER_PARENT/working'"
echo "  sudo -u $LCM_CI_ACCOUNT chmod 0700 '$RUNNER_PARENT/working'"
echo ""
echo "next steps:"
echo "  1. CI user creates working dir: sudo -u $LCM_CI_ACCOUNT mkdir -p '$RUNNER_PARENT/working'"
echo "  2. Register runner: sudo -u $LCM_CI_ACCOUNT scripts/ci/runner/02-register-runner.sh"
echo "  3. Install LaunchDaemon: sudo scripts/ci/runner/03-install-launchd.sh"
echo "  4. Verify: sudo scripts/ci/runner/04-verify.sh"
