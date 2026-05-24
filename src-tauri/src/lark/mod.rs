//! Rust-side `lark-cli` shell-out. Mirrors the four IM operations the
//! sidecar triage previously spawned `lark-cli` for. Centralized here so
//! future surfaces (e.g. a Lark inbox UI parallel to Slack/GitHub) reuse
//! the same auth + error model.

mod cli;
pub mod im;

pub use cli::auth_status;
