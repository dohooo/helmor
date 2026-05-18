//! Account-global rate-limit fetchers, one module per provider.
//!
//! Each provider authenticates with its own OAuth flow and pulls the
//! raw upstream JSON without shape mapping — downstream parsing lives
//! in the frontend so a schema change at the provider only requires a
//! parser tweak (no DB migration).

pub mod claude;
pub mod codex;
pub mod throttle;
