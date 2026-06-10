# Local Release Validation

Validate the macOS release flow locally before moving the same values into GitHub Actions. Windows is built in GitHub Actions on `windows-latest`.

## 1. Prepare local secrets

Copy the template:

```bash
cp .env.release.local.example .env.release.local
```

Fill every value in `.env.release.local`.

## 2. Run local validation

```bash
scripts/release-local-macos.sh
```

The script will:

- load `.env.release.local`
- import the Developer ID certificate into a temporary keychain
- verify version alignment across release files
- confirm the requested codesigning identity exists
- verify `notarytool` is available
- run `bun x tauri build --bundles app,dmg --ci`
- re-sign nested vendored executables that ship inside `Resources/vendor`
- notarize and staple the macOS app bundle

## 3. What to check after the build

- `src-tauri/target/release/bundle/dmg/`
- `src-tauri/target/release/bundle/macos/`
- the updater bundle (`Helmor.app.tar.gz`) and signature (`.sig`)

`latest.json` is not produced by the local `tauri build` command. Helmor publishes
that file in GitHub Actions through the official `tauri-action`, which uses the
generated updater bundle and signature to create the GitHub Releases metadata.

## 4. Move to GitHub Actions after local success

After the local build succeeds, copy the same values into the GitHub repository secrets described in [release-secrets.md](./release-secrets.md).

## 5. Windows installer check

The Windows x64 NSIS installer is not built by the local macOS validation script.
It is built and published to GitHub Releases in CI by the `build-and-publish-windows`
job within `publish.yml`, which runs alongside the macOS release jobs. The
`tauri-action` merges the Windows entry into the same `latest.json` as macOS
for the in-app updater:

- `src-tauri/target/release/bundle/nsis/*-setup.exe`

The same secrets and environment variables used for macOS release publishing
are required for Windows.
