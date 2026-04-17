#!/usr/bin/env bash
set -euo pipefail

KEYCHAIN_PATH="${1:-${APPLE_KEYCHAIN_PATH:-}}"

if [[ -n "${KEYCHAIN_PATH}" && -f "${KEYCHAIN_PATH}" ]]; then
  security delete-keychain "${KEYCHAIN_PATH}" >/dev/null 2>&1 || true
fi
