# Release Secrets

Configure these GitHub repository secrets before running the macOS release workflow.

## Required for release creation

- `GITHUB_TOKEN`
  - Provided automatically by GitHub Actions
  - Must have `contents: write` permission in the workflow

## Required for Tauri updater signing

- `TAURI_SIGNING_PRIVATE_KEY`
  - Contents of your Tauri updater private key
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  - Password used when generating the updater private key
- `HELMOR_UPDATER_PUBKEY`
  - Public key embedded into the app at build time
- `HELMOR_UPDATER_ENDPOINTS`
  - Comma-separated updater endpoint list
  - Stable-only default:
    - `https://github.com/dohooo/helmor/releases/latest/download/latest.json`

GitHub release publication uses the official `tauri-action`. It uploads the signed
updater bundle and generates the `latest.json` manifest consumed by Helmor's updater.

## Required for macOS signing and notarization

- `APPLE_CERTIFICATE`
  - Base64-encoded `.p12` export of your `Developer ID Application` certificate
- `APPLE_CERTIFICATE_PASSWORD`
  - Password used when exporting the `.p12`
- `APPLE_SIGNING_IDENTITY`
  - Example: `Developer ID Application: Your Name (TEAMID)`
- `APPLE_ID`
  - Apple Developer account email
- `APPLE_PASSWORD`
  - App-specific password used for notarization
- `APPLE_TEAM_ID`
  - Apple Developer Team ID

## Local-only files created during setup

The repository now uses ignored `*.local` files for local release setup:

- `tauri-updater-private-key.local`
- `tauri-updater-private-key.local.pub`
- `tauri-updater-password.local`

The macOS release flow also imports the `Developer ID Application` certificate
into a temporary keychain before the build starts so nested vendor binaries can
be re-signed consistently both locally and on GitHub Actions.

Keep the private key and password out of source control and back them up securely.
