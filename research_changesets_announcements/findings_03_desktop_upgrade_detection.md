# Desktop Upgrade Detection Patterns

Goal: detect "first run after update" with the least custom update-state logic.

## Summary

The lowest-custom-logic pattern is:

1. Read the app's current packaged version at startup.
2. Read a persisted `lastSeenVersion` from the app's normal user data/settings store.
3. If `lastSeenVersion` is missing, treat as first install/run.
4. If `lastSeenVersion !== currentVersion`, treat as first run after update, run the announcement/change prompt once, then write `currentVersion`.
5. Keep built-in updater hooks only for update availability/download/install UX, not as the canonical "first launch on this version" detector.

This avoids coupling announcement logic to a specific installer/updater path. It also works when users update manually, skip versions, install from a downloaded package, or receive updates via an OS/package-manager channel.

## Tauri

- Current version: Tauri's JS API exposes `getVersion()` to read the application version.
  - Source: https://v2.tauri.app/reference/javascript/api/namespaceapp/#getversion
- Persisted marker: `@tauri-apps/plugin-store` provides a small key-value store persisted under the app data directory and usable from JS or Rust. Store only a tiny marker such as `lastSeenVersion`.
  - Source: https://v2.tauri.app/plugin/store/
- Built-in updater: Tauri v2's updater plugin exposes `check()`, then `downloadAndInstall()` or separate download/install calls, followed by relaunch through the process plugin. It is good for update flow, but the docs do not present a dedicated cross-platform "first run after update" callback.
  - Source: https://v2.tauri.app/ko/plugin/updater/
- Low-custom recommendation for Helmor-like Tauri apps: run the version comparison once during app boot after settings storage is available. If `previousVersion` exists and differs from `currentVersion`, enqueue/show the changeset announcement and immediately persist `currentVersion` after acknowledging or after marking the announcement as seen.

## Electron

- Current version: `app.getVersion()` returns the loaded app version, using `package.json` or the bundle/executable version.
  - Source: https://www.electronjs.org/docs/latest/api/app/#appgetversion
- Persisted marker location: `app.getPath('userData')` is Electron's per-user app data directory, suitable for a small JSON/store marker.
  - Source: https://www.electronjs.org/docs/latest/api/app/#appgetpathname
- Built-in updater hooks: Electron's `autoUpdater` emits `update-available`, `update-downloaded`, and `before-quit-for-update`; downloaded updates are applied on next start even if `quitAndInstall()` is not called.
  - Source: https://www.electronjs.org/docs/latest/api/auto-updater/
- Electron-builder low-custom option: `electron-updater` can auto-create internal update config and supports `checkForUpdatesAndNotify()`, so apps can avoid custom feed wiring. It still should not be the only source of truth for "did this version already show announcements?"
  - Source: https://www.electron.build/auto-update.html
- Windows/Squirrel caveat: Squirrel.Windows launches apps with special startup arguments during install/update/uninstall; Electron Forge recommends handling those early with `electron-squirrel-startup`. These are installer lifecycle events, not a durable "user's first normal launch on version X" state.
  - Source: https://www.electronforge.io/config/makers/squirrel.windows
  - Source: https://www.electronjs.org/docs/latest/api/auto-updater/#squirrelwindows

## Native/Platform Updaters

- macOS Sparkle can handle update UX with very little app code. `SUAutomaticallyUpdate` enables automatic background download/install behavior, and Sparkle exposes delegate/user-driver hooks such as downloaded, will install, ready to install and relaunch.
  - Source: https://sparkle-project.github.io/documentation/customization/
  - Source: https://sparkle-project.org/documentation/api-reference/Protocols/SPUUpdaterDelegate.html
  - Source: https://sparkle-project.github.io/documentation/api-reference/Protocols/SPUUserDriver.html
- Windows MSIX/App Installer can move update checks out of app code. The `.appinstaller` `UpdateSettings` can check on launch, check in the background, show prompts, block activation for required updates, and control check frequency.
  - Source: https://learn.microsoft.com/en-us/windows/msix/app-installer/update-settings
- Even with Sparkle/MSIX, announcement detection should still compare persisted previous app version to current app version. Platform update hooks answer "an update is being installed/downloaded"; version comparison answers "this user is now running a version they have not seen before."

## Recommended Shape

Use one durable record:

```ts
type UpgradeDetectionState = {
	lastSeenVersion?: string;
	lastAnnouncementVersion?: string;
};
```

Minimal logic:

```ts
const currentVersion = await getCurrentAppVersion();
const state = await loadUpgradeDetectionState();

const isFirstRun = !state.lastSeenVersion;
const isFirstRunAfterUpdate =
	!!state.lastSeenVersion && state.lastSeenVersion !== currentVersion;

if (isFirstRunAfterUpdate && state.lastAnnouncementVersion !== currentVersion) {
	showChangesetAnnouncement({ from: state.lastSeenVersion, to: currentVersion });
	await saveUpgradeDetectionState({
		lastSeenVersion: currentVersion,
		lastAnnouncementVersion: currentVersion,
	});
} else if (state.lastSeenVersion !== currentVersion) {
	await saveUpgradeDetectionState({ ...state, lastSeenVersion: currentVersion });
}
```

Notes:

- Use semantic version comparison only if the product needs to distinguish upgrades from downgrades. For announcements, string inequality is usually enough and handles skipped versions.
- Do not depend on updater events alone. They miss manual installs, store/MSIX/package-manager updates, and cases where the update was downloaded in one process and first launched later.
- Store this state in the existing settings/user-data persistence layer, not in installation directories, because installation directories may be replaced during upgrades.
