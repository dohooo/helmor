# Tauri Auto Update Research Report

## Bottom Line

The requested flow is feasible in Tauri v2 desktop apps using the official updater stack.

Recommended stack:
- `tauri-plugin-updater`
- GitHub Releases as a hosting layer for signed updater artifacts plus `latest.json`
- `tauri-action` in CI to publish artifacts and updater manifest
- app-managed scheduling logic for startup / focus / periodic checks
- custom in-app toast for "download complete" and "install + restart"

Do not rely on plain GitHub release pages alone. Tauri updater consumes signed updater metadata and artifacts, not generic release listings.

## Recommended Architecture

1. Release pipeline
- Generate updater artifacts with `bundle.createUpdaterArtifacts`
- Sign with Tauri updater signing key
- Publish artifacts and `latest.json` to GitHub Releases using `tauri-action`

2. Runtime orchestration
- Run update orchestration in Rust backend
- Trigger checks on:
  - app startup
  - app resumed / main window focused
  - a coarse periodic timer
- Gate all triggers behind one singleflight state machine with throttling

3. Download and prompt flow
- `check()` for update
- if update exists, silently `download()`
- when download finishes, mark update as ready
- show custom bottom-right toast only after download completion
- `View Change Log` opens release URL
- `Update and Restart` runs install path

4. UI behavior
- no early modal or prompt
- optional subtle background indicator while downloading
- one-shot toast after completion, deduped by version

## Important Constraints

- Tauri v2 removed the old built-in updater prompt behavior; you control the whole UX
- updater signatures are mandatory
- production updater transport should be HTTPS
- GitHub `releases/latest` only tracks the latest non-draft, non-prerelease release
- Windows silent install has caveats; `passive` is usually safer than `quiet`
- download and install are tied to updater state; Rust-side retention is safer for deferred install

## Key Sources

- https://v2.tauri.app/plugin/updater/
- https://v2.tauri.app/reference/javascript/updater/
- https://v2.tauri.app/start/migrate/from-tauri-1/
- https://v2.tauri.app/distribute/pipelines/github/
- https://github.com/tauri-apps/tauri-action
- https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/guest-js/index.ts
- https://docs.rs/tauri-plugin-updater/latest/tauri_plugin_updater/trait.UpdaterExt.html
- https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases
