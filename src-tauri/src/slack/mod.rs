//! Slack as a Context source.
//!
//! Authentication = "import from the user's Slack desktop session":
//! we read the `xoxc-…` token out of Slack's Local Storage leveldb and
//! the `d` cookie value out of Slack's Cookies SQLite (decrypted with
//! the macOS Keychain's "Slack Safe Storage" key). See
//! `desktop_scrape.rs` for the full extraction pipeline.
//!
//! Why we don't ship an in-app sign-in flow: tried it (an EZ-Login
//! style WebView at app.slack.com), but Slack actively rejects
//! non-Electron browsers and adds new auth hops (passkey, admin 2FA,
//! SSO) frequently enough that the maintenance treadmill isn't worth
//! it. The desktop client has already completed all of those, so we
//! reuse what's on disk.
//!
//! Credentials are stored in the macOS Keychain via `/usr/bin/security`
//! (see `credentials.rs` for why we don't use the `keyring` crate);
//! non-secret workspace metadata (team id / name / domain / our user
//! id) goes into the `slack_workspaces` SQLite table.
//!
//! Live data is fetched by calling Slack's Web API directly with the
//! captured pair (`token=xoxc-…` form field, `Cookie: d=xoxd-…`).
//! Read-only in v1 — no posting, no reactions, no file writes.

pub mod api;
pub mod credentials;
pub mod desktop_scrape;
pub mod detail;
pub mod files;
pub mod inbox;
pub mod types;

pub use credentials::{clear_credentials, load_credentials, store_credentials, SlackCreds};
pub use types::{
    SlackInboxItem, SlackInboxItemKind, SlackInboxPage, SlackThreadDetail, SlackWorkspace,
};
