#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_ENV_FILE="${ROOT_DIR}/.env.release.local"

if [[ ! -f "${RELEASE_ENV_FILE}" ]]; then
  echo "Missing ${RELEASE_ENV_FILE}"
  echo "Copy .env.release.local.example to .env.release.local and fill it first."
  exit 1
fi

eval "$(
  python3 - "${RELEASE_ENV_FILE}" <<'PY'
import shlex
import sys
from pathlib import Path

env_path = Path(sys.argv[1])
for raw_line in env_path.read_text().splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    print(f"export {key}={shlex.quote(value)}")
PY
)"

required_vars=(
  HELMOR_UPDATER_ENDPOINTS
  HELMOR_UPDATER_PUBKEY
  TAURI_SIGNING_PRIVATE_KEY
  APPLE_CERTIFICATE
  APPLE_CERTIFICATE_PASSWORD
  APPLE_SIGNING_IDENTITY
  APPLE_ID
  APPLE_PASSWORD
  APPLE_TEAM_ID
)

missing=()
for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    missing+=("${var_name}")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "Missing required variables in .env.release.local:"
  printf '  - %s\n' "${missing[@]}"
  exit 1
fi

if ! command -v security >/dev/null 2>&1; then
  echo "security command is required on macOS"
  exit 1
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "xcrun is required on macOS"
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required"
  exit 1
fi

echo "Preparing macOS signing keychain..."
keychain_env="$(scripts/prepare-macos-signing.sh)"
eval "${keychain_env}"
trap 'scripts/cleanup-macos-signing.sh "${APPLE_KEYCHAIN_PATH:-}"' EXIT

echo "Verifying local release configuration..."
bun run release:verify

echo "Checking signing identity..."
if ! security find-identity -v -p codesigning | grep -F "${APPLE_SIGNING_IDENTITY}" >/dev/null; then
  echo "Signing identity not found: ${APPLE_SIGNING_IDENTITY}"
  security find-identity -v -p codesigning || true
  exit 1
fi

echo "Checking notarization tool availability..."
xcrun notarytool --version >/dev/null

echo "Building Helmor macOS release..."
bun x tauri build --bundles app,dmg --ci

echo "macOS release build finished."
echo
echo "Expected artifacts:"
echo "  - src-tauri/target/release/bundle/dmg/"
echo "  - src-tauri/target/release/bundle/macos/"
echo "  - src-tauri/target/release/bundle/macos/Helmor.app.tar.gz"
echo "  - src-tauri/target/release/bundle/macos/Helmor.app.tar.gz.sig"
echo
echo "latest.json is published in CI by tauri-action using these updater artifacts."
