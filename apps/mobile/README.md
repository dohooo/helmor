# Helmor Mobile

Expo iOS app for the Helmor mobile companion.

## Local Preview

From the repository root:

```bash
bun run mobile:setup-ios
bun run mobile:doctor
bun run mobile:ios
```

`mobile:setup-ios` completes Xcode's first-launch setup. It may ask for your
macOS password the first time. `mobile:ios` starts Expo in Expo Go mode and
opens the iOS Simulator.

For a connected iPhone native build:

```bash
bun run mobile:device
```

If Xcode says a selected device is ineligible, inspect the device state:

```bash
bun run mobile:devices
```

`devicectl` must show the iPhone as available, and `xctrace` must not list it
under "Devices Offline". If the build says `iOS <version> is not installed`,
open Xcode > Settings > Components and install the matching iOS platform/device
support. Keep the iPhone unlocked, connected over USB, trusted, and with
Developer Mode enabled while Xcode finishes preparing it.

## Checks

```bash
bun run mobile:doctor
bun run mobile:verify
```

`mobile:verify` runs TypeScript, Bun tests, and an iOS Expo export.
