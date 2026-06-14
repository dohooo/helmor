---
"helmor": patch
---

Fix Intel (x86_64) builds shipping an arm64 `helmor-sidecar`, which made the app fail to launch its sidecar with "Failed to start sidecar binary" / "bad CPU type in executable" on Intel Macs. The sidecar is now cross-compiled to the release target triple, and the bundle arch check covers it so the mismatch can't ship again.
