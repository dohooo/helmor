# Linux Build Guide for Helmor

This document describes the changes and steps required to build Helmor on Linux (tested on Ubuntu 24.04).

## Background

Helmor is a Tauri v2 desktop application. While the Rust backend and frontend are cross-platform, the official releases currently only target **macOS**. The main blocker for Linux builds was the `sidecar/scripts/stage-vendor.ts` script, which explicitly threw an error for non-macOS platforms.

## Changes Made

### 1. `sidecar/scripts/stage-vendor.ts`

This script downloads and stages vendor binaries (`gh`, `glab`, `bun`, `codex`, `claude-code`) into `sidecar/dist/vendor/` so Tauri can bundle them into the final application.

**Problem:** The original script had a hard check that aborted on anything other than `darwin`:
```ts
if (process.platform !== "darwin") {
  throw new Error(`[stage-vendor] Helmor only builds on macOS; host platform is ${process.platform}`);
}
```

**Solution:** Extended the script to support Linux (`x64` and `arm64`) by:
- Adding Linux download URLs and SHA256 checksums for `gh`, `glab`, `bun`, and `codex`.
- Adding Linux-specific `TargetInfo` mappings (e.g. `x86_64-unknown-linux-musl` for Codex).
- Updating `detectTarget()` to accept `linux` as a valid platform and resolve the correct target triple.
- Updating `stageGhBinary()`, `stageGlabBinary()`, and `stageBunBinary()` to use the platform-specific archive names and checksums.

Key SHA256 values added:
| Tool | Platform | Arch | SHA256 |
|---|---|---|---|
| gh 2.91.0 | linux | amd64 | `304a0d2460f4a8847d2f192bad4e2a32cd9420d28716e7ae32198181b65b5f9c` |
| glab 1.93.0 | linux | amd64 | `300f3c12bd75f298747364f382f978bbe63809ef660bb2969925f343f9c20ae4` |
| bun 1.3.2 | linux | x64 | `0cb56a4484bd7764a3eef9b9e67ab457840981287b46794974d1e6612cbf6709` |
| codex 0.124.0 | linux | x64 | `aee2637ad90e607737297d6da1a32245c14f731754c14bc15fcacc3b6b244fdc` |

**Note:** `claude-code` is installed via npm and its Linux vendor binaries (`arm64-linux`, `x64-linux`) were already present in the package, so no download changes were needed for it.

### 2. Dummy `sccache` Wrapper

During the build, Cargo attempted to use `sccache` as a `rustc` wrapper but the binary was not installed on the system.

**Workaround:** A pass-through wrapper script was created at `~/.cargo/bin/sccache`:
```sh
#!/bin/sh
exec "$@"
```

This satisfies Cargo without installing the real `sccache`. For optimal build speeds, consider installing the real `sccache`:
```bash
cargo install sccache
```

## System Prerequisites

Ensure the following are installed before building:

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libssl-dev build-essential libayatana-appindicator3-dev librsvg2-dev
```

Also required:
- **Rust** (via rustup)
- **Node.js** (v22+ recommended)
- **Bun** (v1.3+)

## Build Steps

```bash
# 1. Install bun if not already installed
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

# 2. Install dependencies
bun install

# 3. Build Linux release packages
bunx tauri build
```

## Build Results

Successful bundles produced in `src-tauri/target/release/bundle/`:

- **`.deb`** (Debian/Ubuntu): `deb/Helmor_0.12.2_amd64.deb` (~219 MB)
- **`.rpm`** (Fedora/openSUSE): `rpm/Helmor-0.12.2-1.x86_64.rpm` (~219 MB)

**Note:** `.AppImage` bundling may fail if `libfuse2` is not installed. If you need an AppImage, install `libfuse2` and retry the build.

## Installation

### Debian / Ubuntu

```bash
sudo dpkg -i src-tauri/target/release/bundle/deb/Helmor_0.12.2_amd64.deb
```

If dependency errors occur:
```bash
sudo apt-get install -f
```

### RPM-based (Fedora, openSUSE, etc.)

```bash
sudo rpm -i src-tauri/target/release/bundle/rpm/Helmor-0.12.2-1.x86_64.rpm
```

## Known Issues / Warnings

- The Rust build emits **17 warnings** about unused imports and dead code on Linux. These are harmless and mostly related to macOS-only functionality (e.g., AppleScript helpers, Keychain constants) that is conditionally compiled but still parsed on non-macOS targets.
- macOS-specific UI features (overlay title bar, traffic light positioning) will not appear on Linux. The app will use the system's standard window decorations.
- The official updater endpoint in `tauri.conf.json` points to GitHub releases. Since official Linux releases are not published yet, the auto-updater will not find updates on Linux unless you maintain your own release feed.
