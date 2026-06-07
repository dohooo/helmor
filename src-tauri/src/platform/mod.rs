//! Cross-platform OS abstractions.
//!
//! Each submodule exposes one API with `unix`/`windows` implementations behind
//! it so call sites stay platform-agnostic. Submodules are added per phase of
//! the Windows port (see `docs/superpowers/plans/2026-06-07-windows-port.md`).

pub mod fs;
pub mod process;

// Phase 3:  pub mod ipc;
// Phase 4:  pub mod creds; pub mod slack_creds; pub mod hardware;
