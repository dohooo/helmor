#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <Helmor.app path>"
  exit 1
fi

APP_BUNDLE="$1"
CLI_PATH="${APP_BUNDLE}/Contents/MacOS/helmor-cli"

if [[ ! -d "${APP_BUNDLE}" ]]; then
  echo "App bundle not found: ${APP_BUNDLE}"
  exit 1
fi

if [[ ! -x "${CLI_PATH}" ]]; then
  echo "Bundled CLI missing or not executable: ${CLI_PATH}"
  exit 1
fi

echo "Verifying bundled CLI at ${CLI_PATH}..."
OUTPUT="$("${CLI_PATH}" cli-status --json)"

if [[ -z "${OUTPUT}" ]]; then
  echo "Bundled CLI returned empty output"
  exit 1
fi

if [[ "${OUTPUT}" != *'"buildMode"'* ]] || [[ "${OUTPUT}" != *'"currentBinary"'* ]]; then
  echo "Bundled CLI did not return the expected cli-status JSON:"
  echo "${OUTPUT}"
  exit 1
fi

echo "Bundled CLI smoke check passed."

# ----- Vendor binary architecture check -----------------------------------
# helmor-cli is built per-arch via cargo --target, so its lipo arch is the
# source of truth for what this bundle is targeting. Every vendored binary
# must match — otherwise an x64 .dmg ends up shipping arm64 `gh` and Intel
# users see "bad CPU type in executable" (#293).
EXPECTED_ARCH="$(lipo -archs "${CLI_PATH}")"
case "${EXPECTED_ARCH}" in
  arm64)  CC_VENDOR_ARCH="arm64-darwin" ;;
  x86_64) CC_VENDOR_ARCH="x64-darwin" ;;
  *)
    echo "Unexpected helmor-cli arch '${EXPECTED_ARCH}' (want arm64 or x86_64)"
    exit 1
    ;;
esac

VENDOR_ROOT="${APP_BUNDLE}/Contents/Resources/vendor"
VENDOR_BINARIES=(
  "${VENDOR_ROOT}/gh/gh"
  "${VENDOR_ROOT}/glab/glab"
  "${VENDOR_ROOT}/bun/bun"
  "${VENDOR_ROOT}/codex/codex"
  "${VENDOR_ROOT}/claude-code/vendor/ripgrep/${CC_VENDOR_ARCH}/rg"
  "${VENDOR_ROOT}/claude-code/vendor/audio-capture/${CC_VENDOR_ARCH}/audio-capture.node"
)

echo "Verifying vendor binary archs (expect ${EXPECTED_ARCH})..."
mismatches=0
for bin in "${VENDOR_BINARIES[@]}"; do
  if [[ ! -e "${bin}" ]]; then
    # ripgrep / audio-capture are optional features — skip if not staged.
    case "${bin}" in
      *ripgrep*|*audio-capture*) continue ;;
      *)
        echo "  MISSING ${bin}"
        mismatches=$((mismatches + 1))
        continue
        ;;
    esac
  fi
  actual="$(lipo -archs "${bin}" 2>/dev/null || echo "?")"
  if [[ "${actual}" != "${EXPECTED_ARCH}" ]]; then
    echo "  MISMATCH ${bin}: got '${actual}', want '${EXPECTED_ARCH}'"
    mismatches=$((mismatches + 1))
  else
    echo "  ok ${bin}"
  fi
done

if [[ "${mismatches}" -ne 0 ]]; then
  echo "Vendor binary arch check failed (${mismatches} issue(s))"
  exit 1
fi

echo "Vendor binary arch check passed."
