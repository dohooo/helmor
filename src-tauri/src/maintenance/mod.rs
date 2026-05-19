//! Best-effort cleanup of data-dir state that the rest of the app can't
//! treat as authoritative. Each sub-module owns one resource and exposes
//! a `sweep()` for boot-time GC.

pub mod paste_cache;
