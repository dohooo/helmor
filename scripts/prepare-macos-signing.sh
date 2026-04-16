#!/usr/bin/env bash
set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then
  echo "prepare-macos-signing.sh can only run on macOS"
  exit 1
fi

required_vars=(
  APPLE_CERTIFICATE
  APPLE_CERTIFICATE_PASSWORD
  APPLE_SIGNING_IDENTITY
)

for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    echo "Missing ${var_name}"
    exit 1
  fi
done

KEYCHAIN_NAME="${KEYCHAIN_NAME:-helmor-release.keychain-db}"
KEYCHAIN_PASSWORD="${KEYCHAIN_PASSWORD:-$(uuidgen)}"
KEYCHAIN_PATH="${HOME}/Library/Keychains/${KEYCHAIN_NAME}"
CERT_PATH="$(mktemp -t helmor-cert).p12"
OUTPUT_FORMAT="${OUTPUT_FORMAT:-shell}"

cleanup() {
  rm -f "${CERT_PATH}"
}
trap cleanup EXIT

printf '%s' "${APPLE_CERTIFICATE}" | base64 --decode > "${CERT_PATH}"

if security list-keychains | grep -F "${KEYCHAIN_PATH}" >/dev/null 2>&1; then
  security delete-keychain "${KEYCHAIN_PATH}" >/dev/null 2>&1 || true
fi

security create-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_PATH}" >/dev/null
security set-keychain-settings -lut 21600 "${KEYCHAIN_PATH}" >/dev/null
security unlock-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_PATH}" >/dev/null
security import "${CERT_PATH}" -k "${KEYCHAIN_PATH}" -P "${APPLE_CERTIFICATE_PASSWORD}" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_PATH}" >/dev/null
security list-keychains -d user -s "${KEYCHAIN_PATH}" login.keychain-db >/dev/null
security default-keychain -d user -s "${KEYCHAIN_PATH}" >/dev/null

case "${OUTPUT_FORMAT}" in
  shell)
    echo "export APPLE_KEYCHAIN_PATH=${KEYCHAIN_PATH}"
    echo "export APPLE_KEYCHAIN_PASSWORD=${KEYCHAIN_PASSWORD}"
    ;;
  github)
    echo "APPLE_KEYCHAIN_PATH=${KEYCHAIN_PATH}"
    echo "APPLE_KEYCHAIN_PASSWORD=${KEYCHAIN_PASSWORD}"
    ;;
  *)
    echo "Unsupported OUTPUT_FORMAT: ${OUTPUT_FORMAT}"
    exit 1
    ;;
esac
