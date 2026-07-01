#!/usr/bin/env bash
# Compute the darwin arm64 + x64 npm-tarball SHA256s for a Helmor class-B staged binary,
# ready to paste into the matching table in sidecar/scripts/vendor-platform.ts.
#
# Usage:   npm_vendor_sha.sh <claude-code|codex|opencode> <version>
# Example: npm_vendor_sha.sh opencode 1.17.10
#
# Prints two lines:  arm64: <sha256>   /   x64: <sha256>
# These are SHA256 of the *.tgz tarballs (what downloadAndVerify compares), NOT the npm
# registry's sha1/sha512 dist metadata — so they must be computed from the tarball itself.
set -euo pipefail

vendor="${1:?usage: npm_vendor_sha.sh <claude-code|codex|opencode> <version>}"
version="${2:?missing version (e.g. 2.1.191)}"

tarball_url() { # $1 = arm64|x64
  local arch="$1"
  case "$vendor" in
    claude-code) printf 'https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-%s/-/claude-code-darwin-%s-%s.tgz' "$arch" "$arch" "$version" ;;
    codex)       printf 'https://registry.npmjs.org/@openai/codex/-/codex-%s-darwin-%s.tgz' "$version" "$arch" ;;
    opencode)    printf 'https://registry.npmjs.org/opencode-darwin-%s/-/opencode-darwin-%s-%s.tgz' "$arch" "$arch" "$version" ;;
    *) printf 'unknown vendor: %s (expected claude-code|codex|opencode)\n' "$vendor" >&2; exit 2 ;;
  esac
}

for arch in arm64 x64; do
  url="$(tarball_url "$arch")"
  sha="$(curl -fsSL "$url" | shasum -a 256 | cut -d' ' -f1)"
  if [ -z "$sha" ] || [ "$sha" = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ]; then
    printf 'ERROR: empty/zero-byte download for %s — check the version exists: %s\n' "$arch" "$url" >&2
    exit 1
  fi
  printf '%s: %s\n' "$arch" "$sha"
done
