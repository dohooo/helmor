//! Cross-platform Claude OAuth credentials loader.
//!
//! Each platform has its own backend:
//! - macOS: Keychain via `/usr/bin/security` + the Security framework
//!   (in `macos_keychain`).
//! - Linux: the on-disk `~/.claude/.credentials.json` file Claude CLI
//!   maintains itself (in `super::linux_credentials`).
//! - Other targets: hard error (no Claude credentials path defined).
//!
//! This module's only job is to expose `load_best_credentials` on every
//! supported target and dispatch to the right backend.

#[cfg(target_os = "macos")]
mod macos_keychain;

#[cfg(target_os = "macos")]
pub(super) use macos_keychain::load_best_credentials;

#[cfg(target_os = "linux")]
pub(super) use super::linux_credentials::load_best_credentials;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(super) fn load_best_credentials() -> anyhow::Result<super::credentials::ClaudeOAuthCredentials>
{
    anyhow::bail!("Claude OAuth credentials not supported on this platform")
}
