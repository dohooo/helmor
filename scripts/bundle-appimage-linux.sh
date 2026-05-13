#!/usr/bin/env bash
# Wrap linuxdeploy + plugin-appimage to package Helmor's AppDir as a .AppImage
# while sidestepping the bug where linuxdeploy crashes on our self-contained
# binaries.
#
# Background
# ----------
# `tauri build --bundles appimage` invokes linuxdeploy which, by default,
# walks every ELF executable under <AppDir>/usr/bin/ and <AppDir>/usr/lib/
# to compute and copy in their shared-library dependencies. For most
# binaries this is fine, but Helmor ships several that linuxdeploy chokes
# on:
#
#   * helmor-sidecar  (Bun `bun build --compile` output)
#   * vendor/codex/codex          (Bun --compile)
#   * vendor/claude-code/claude   (Bun --compile)
#       The Bun-compile format embeds a JS runtime + bytecode after the
#       ELF section table, and the resulting binary upsets `ldd` (exits 1
#       with no output). linuxdeploy then aborts with a C++
#       runtime_error: "Failed to run ldd: exited with code 1".
#
#   * vendor/gh/gh    (Go static binary)
#   * vendor/glab/glab(Go static binary)
#       Static Go binaries have no .dynamic section. linuxdeploy still
#       calls patchelf on them and aborts with "cannot find section
#       .dynamic".
#
# All five are self-contained — they have no shared-library dependencies
# linuxdeploy could supply anyway. The fix is to hide them from
# linuxdeploy during dependency deployment, then put them back before
# squashing the AppDir into the final .AppImage.
#
# Workflow
# --------
#   1. Stash the problem binaries outside the AppDir.
#   2. Run linuxdeploy --output appimage so it can ldd the well-behaved
#      binaries (helmor, helmor-cli, …) and copy in WebKit/GTK runtime
#      libs.
#   3. Restore the stashed binaries.
#   4. Re-invoke linuxdeploy-plugin-appimage on the now-complete AppDir.
#      This step only mksquashfs's the directory and prepends the
#      AppImage runtime — it does not re-run dependency analysis.
#   5. Rename the AppImage to the requested output name.
#
# Usage
# -----
#   scripts/bundle-appimage-linux.sh <appdir-path> <output-appimage>
#
# Example
#   scripts/bundle-appimage-linux.sh \
#     src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage/Helmor.AppDir \
#     src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage/Helmor_0.21.3_amd64.AppImage
#
# Prerequisites: `linuxdeploy-x86_64.AppImage` and
# `linuxdeploy-plugin-appimage.AppImage` are downloaded under
# ~/.cache/tauri/ by a prior `tauri build` (or by `tauri-action` in CI).
#
# Exit status: 0 on success, non-zero with a stderr message on failure.
# A trap restores any stashed binaries even if a step fails.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <appdir-path> <output-appimage>" >&2
  exit 64
fi

APPDIR="$1"
OUTPUT="$2"

if [ ! -d "$APPDIR" ]; then
  echo "error: AppDir not found: $APPDIR" >&2
  exit 1
fi

LINUXDEPLOY="${LINUXDEPLOY_BIN:-$HOME/.cache/tauri/linuxdeploy-x86_64.AppImage}"
LINUXDEPLOY_PLUGIN_APPIMAGE="${LINUXDEPLOY_PLUGIN_APPIMAGE_BIN:-$HOME/.cache/tauri/linuxdeploy-plugin-appimage.AppImage}"

for tool in "$LINUXDEPLOY" "$LINUXDEPLOY_PLUGIN_APPIMAGE"; do
  if [ ! -x "$tool" ]; then
    echo "error: missing tool: $tool" >&2
    echo "       run \`tauri build --bundles appimage\` once to populate ~/.cache/tauri/" >&2
    exit 1
  fi
done

# Self-contained binaries that break linuxdeploy. Paths are relative to
# the AppDir root. If a path doesn't exist (e.g. a future build drops
# one of these tools), we silently skip it — no need to fail the bundle
# over a missing optional vendor binary.
STASH_PATHS=(
  "usr/bin/helmor-sidecar"
  "usr/lib/Helmor/vendor/claude-code"
  "usr/lib/Helmor/vendor/codex"
  "usr/lib/Helmor/vendor/gh"
  "usr/lib/Helmor/vendor/glab"
)

STASH_DIR="$(mktemp -d -t helmor-appimage-stash.XXXXXX)"

restore_stash() {
  local rc=$?
  # Best-effort rehydrate of the AppDir on failure. Idempotent — if the
  # success path already moved a stashed entry back, we skip it.
  if [ -d "$STASH_DIR" ]; then
    for rel in "${STASH_PATHS[@]}"; do
      local stashed_name
      stashed_name="$(printf '%s' "$rel" | tr '/' '__')"
      local src="$STASH_DIR/$stashed_name"
      local dst="$APPDIR/$rel"
      if [ -e "$src" ] && [ ! -e "$dst" ]; then
        mkdir -p "$(dirname "$dst")"
        cp -a "$src" "$dst"
      fi
    done
    rm -rf -- "$STASH_DIR"
  fi
  exit "$rc"
}
trap restore_stash EXIT

# Step 1 — stash.
for rel in "${STASH_PATHS[@]}"; do
  src="$APPDIR/$rel"
  if [ -e "$src" ]; then
    stashed_name="$(printf '%s' "$rel" | tr '/' '__')"
    mv "$src" "$STASH_DIR/$stashed_name"
  fi
done

# Step 2 — let linuxdeploy compute and deploy real shared-lib deps for
# the remaining (well-behaved) binaries. NO_STRIP=true keeps debug
# symbols in helmor-cli for crash analysis.
NO_STRIP=true \
  "$LINUXDEPLOY" \
    --appdir "$APPDIR" \
    --plugin gtk \
    --output appimage \
    > /dev/null

# Step 2 produces an .AppImage in the cwd that's missing the binaries we
# stashed. Throw it away — we'll repackage in step 4.
rm -f -- *.AppImage

# Step 3 — restore stashed binaries before squashing the final AppImage.
# We do this here (rather than waiting for the EXIT trap) so the binaries
# are in place before plugin-appimage runs. The trap's `! -e dst` guard
# makes the duplicate restore on success a no-op.
for rel in "${STASH_PATHS[@]}"; do
  stashed_name="$(printf '%s' "$rel" | tr '/' '__')"
  src="$STASH_DIR/$stashed_name"
  dst="$APPDIR/$rel"
  if [ -e "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    mv "$src" "$dst"
  fi
done

# Step 4 — repackage the now-complete AppDir. plugin-appimage only runs
# mksquashfs + prepends the runtime; it doesn't re-traverse with ldd, so
# our self-contained binaries pass through untouched. APPIMAGE_EXTRACT_AND_RUN
# avoids needing libfuse2 just to run the plugin itself.
APPIMAGE_EXTRACT_AND_RUN=1 \
  "$LINUXDEPLOY_PLUGIN_APPIMAGE" \
    --appdir "$APPDIR" \
    > /dev/null

# Step 5 — plugin-appimage names the output `<App>-x86_64.AppImage` in
# the cwd. Move it to the requested output path.
produced="$(ls *.AppImage 2>/dev/null | head -n 1 || true)"
if [ -z "$produced" ] || [ ! -f "$produced" ]; then
  echo "error: plugin-appimage did not produce an .AppImage in $(pwd)" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"
mv "$produced" "$OUTPUT"

echo "$OUTPUT"
