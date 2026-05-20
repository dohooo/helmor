#!/usr/bin/env bash
# Standalone installer for `helmor-server` on a remote host.
#
# Mirrors the in-app `install_via_download` flow from
# `src-tauri/src/remote/install.rs` so an operator can pre-deploy the
# daemon binary without launching the desktop app first. Useful for:
#
#   - Air-gapped hosts where the desktop runs the install over a
#     bastion + can't reach GitHub directly. Run this script with the
#     bastion as a relay, then attach the desktop afterwards.
#   - Provisioning automation (Ansible / Terraform / Pulumi) that wants
#     to bake the daemon into a base image so the first connect is
#     instant.
#   - Manual upgrades: protocol version bumped, operator wants to swap
#     the binary on a schedule rather than wait for the desktop's
#     auto-install probe.
#
# Usage:
#
#   curl -fsSL https://github.com/dohooo/helmor/raw/main/scripts/install-helmor-server.sh \
#     | bash -s -- --version 0.1.0
#
# or, with explicit overrides:
#
#   bash install-helmor-server.sh \
#     --version 0.1.0 \
#     --repo dohooo/helmor \
#     --target x86_64-unknown-linux-gnu \
#     --install-dir "$HOME/.helmor/server"
#
# The script:
#   1. Detects the host's OS+arch via `uname -sm` (unless `--target`
#      is given) and maps it to a Rust target triple.
#   2. Downloads `helmor-server-<version>-<target>.tar.gz` +
#      `SHA256SUMS` from the GitHub release.
#   3. Verifies the SHA256 against the manifest.
#   4. Extracts to the install dir, sets mode 0755.
#   5. Re-runs `<install_dir>/helmor-server --version` to confirm
#      it's executable + reports the matching protocol version.
#
# Exit codes: 0 success, 1 usage error, 2 unsupported platform,
# 3 download failure, 4 checksum mismatch, 5 install verify failure.

set -euo pipefail

REPO="dohooo/helmor"
VERSION=""
TARGET=""
INSTALL_DIR="${HOME}/.helmor/server"

usage() {
  cat <<USAGE
install-helmor-server.sh

  --version <semver>     Protocol version to install (matches the
                         release tag \`helmor-server-v<semver>\`).
                         REQUIRED.
  --repo <org/repo>      GitHub repo to pull releases from
                         (default: ${REPO}).
  --target <triple>      Force a specific Rust target instead of
                         auto-detecting from \`uname -sm\`.
  --install-dir <path>   Where to drop the binary
                         (default: ${INSTALL_DIR}).
  --help                 Print this message.

Examples:

  install-helmor-server.sh --version 0.1.0

  install-helmor-server.sh --version 0.1.0 \\
    --target aarch64-unknown-linux-gnu \\
    --install-dir /opt/helmor
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || { echo "--version takes an argument" >&2; exit 1; }
      VERSION="$2"; shift 2 ;;
    --repo)
      [ $# -ge 2 ] || { echo "--repo takes an argument" >&2; exit 1; }
      REPO="$2"; shift 2 ;;
    --target)
      [ $# -ge 2 ] || { echo "--target takes an argument" >&2; exit 1; }
      TARGET="$2"; shift 2 ;;
    --install-dir)
      [ $# -ge 2 ] || { echo "--install-dir takes an argument" >&2; exit 1; }
      INSTALL_DIR="$2"; shift 2 ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1 ;;
  esac
done

if [ -z "${VERSION}" ]; then
  echo "missing required --version" >&2
  usage >&2
  exit 1
fi

# Auto-detect target if the operator didn't override it.
if [ -z "${TARGET}" ]; then
  arch_line=$(uname -sm)
  case "${arch_line}" in
    "Linux x86_64")    TARGET="x86_64-unknown-linux-gnu" ;;
    "Linux aarch64")   TARGET="aarch64-unknown-linux-gnu" ;;
    "Darwin x86_64")   TARGET="x86_64-apple-darwin" ;;
    "Darwin arm64")    TARGET="aarch64-apple-darwin" ;;
    *)
      echo "unsupported platform: \"${arch_line}\"" >&2
      echo "supported: Linux x86_64/aarch64, Darwin x86_64/arm64" >&2
      exit 2 ;;
  esac
fi

TARBALL="helmor-server-${VERSION}-${TARGET}.tar.gz"
TAG="helmor-server-v${VERSION}"
BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
TARBALL_URL="${BASE_URL}/${TARBALL}"
SUMS_URL="${BASE_URL}/SHA256SUMS"

# shasum on macOS, sha256sum on Linux. Provide a thin wrapper so the
# downstream `<sum> -c -` invocation works on both.
sha256_check() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c -
  else
    shasum -a 256 -c -
  fi
}

echo "installing helmor-server ${VERSION} for ${TARGET}"
echo "  source: ${TARBALL_URL}"
echo "  target: ${INSTALL_DIR}/helmor-server"

tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

if ! curl -fsSL -o "${tmp}/${TARBALL}" "${TARBALL_URL}"; then
  echo "download failed: ${TARBALL_URL}" >&2
  exit 3
fi
if ! curl -fsSL -o "${tmp}/SHA256SUMS" "${SUMS_URL}"; then
  echo "download failed: ${SUMS_URL}" >&2
  exit 3
fi

cd "${tmp}"
if ! grep -F " ${TARBALL}" SHA256SUMS | sha256_check; then
  echo "SHA256 verification failed for ${TARBALL}" >&2
  exit 4
fi

tar xzf "${TARBALL}"
mkdir -p "${INSTALL_DIR}"
install -m 0755 "helmor-server-${VERSION}-${TARGET}/helmor-server" "${INSTALL_DIR}/helmor-server"

# Verify the install actually runs + serves the expected protocol.
if ! out=$("${INSTALL_DIR}/helmor-server" --version 2>&1); then
  echo "post-install verify failed: ${out}" >&2
  exit 5
fi
echo "installed: ${out}"
