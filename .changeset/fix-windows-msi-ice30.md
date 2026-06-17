---
"helmor": patch
---

Fix Windows MSI bundling failing with WiX ICE30 by removing the duplicate `helmor-cli` from `externalBin`. The CLI was packaged twice — once via `externalBin` and once via Tauri auto-bundling the crate's `[[bin]]` — which collided on the same install path. Tauri's `[[bin]]` copy alone satisfies the runtime CLI lookup.
