//! Provider API key storage backed by the OS-native vault.
//!
//! Helmor used to stash provider API keys in the desktop's SQLite
//! `settings` table under `app.cursor_provider` (and similar). That
//! data lives on disk in plaintext, which is the kind of thing every
//! security review flags. This module moves the sensitive piece
//! (the `apiKey` string) into the platform vault and leaves the
//! non-sensitive config (model list, endpoints, etc.) in SQLite.
//!
//! ## Platform support
//!
//! Every supported desktop target now has a real vault backend; the
//! "store inline in SQLite" fallback is gone in favour of a fail-fast
//! error so a misconfigured host never silently drops back to
//! plaintext.
//!
//! - **macOS**: `security-framework` writes a `kSecClassGenericPassword`
//!   item under service `com.helmor.api-keys` with the provider name
//!   as the account. The item inherits the user's login keychain by
//!   default, so the user gets the standard "always allow Helmor"
//!   grant prompt on first read. (Kept on the direct security-framework
//!   path so we can match the `errSecItemNotFound` code from the
//!   "no entry" branch — the cross-platform crate hides that detail.)
//! - **Linux**: `keyring` crate, configured with the
//!   `sync-secret-service` feature, talks to the standard
//!   `org.freedesktop.Secret.Service` D-Bus interface (GNOME Keyring,
//!   KWallet, KeePassXC, and any other implementer). The user's
//!   default collection (usually "login") holds the entries.
//! - **Windows**: `keyring` crate, configured with the
//!   `windows-native` feature, writes to the Windows Credential
//!   Manager. Entries land under the same service string as the
//!   macOS variant so dual-boot users see a consistent name.
//!
//! ## Why not just delete from SQLite outright
//!
//! Existing users have keys in SQLite from older releases. We can't
//! silently lose those, and we don't want a UI flow that says "open
//! settings, re-enter your key". The first read after upgrade
//! migrates the key from SQLite → Keychain and clears the SQLite
//! field, so the upgrade is invisible to the user.
//!
//! ## Concurrency
//!
//! The macOS Keychain serialises access for our process; no extra
//! synchronisation needed. The migration window between read + write
//! is small (a few syscalls) and lossy migration is OK — if a write
//! races, the next read just re-migrates from the still-populated
//! SQLite value.

use anyhow::{Context, Result};

/// Keychain "service" string. All Helmor-managed API keys share this
/// service; the per-provider account name distinguishes them.
pub const KEYCHAIN_SERVICE: &str = "com.helmor.api-keys";

/// Read the password for `account` under [`KEYCHAIN_SERVICE`].
/// `Ok(None)` for "no entry exists"; `Err` only on backend failure.
/// Unsupported targets (anything that isn't macOS / Linux / Windows)
/// return `Ok(None)` so the caller's migration path stays inert.
pub fn read_password(account: &str) -> Result<Option<String>> {
    #[cfg(target_os = "macos")]
    {
        macos::read_password(account)
    }
    #[cfg(target_os = "linux")]
    {
        keyring_backend::read_password(account)
    }
    #[cfg(target_os = "windows")]
    {
        keyring_backend::read_password(account)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = account;
        Ok(None)
    }
}

/// Upsert `password` under `account`. Replaces any existing value.
pub fn write_password(account: &str, password: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        macos::write_password(account, password)
    }
    #[cfg(target_os = "linux")]
    {
        keyring_backend::write_password(account, password)
    }
    #[cfg(target_os = "windows")]
    {
        keyring_backend::write_password(account, password)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (account, password);
        // Unsupported platform: treat as success so the caller's
        // "wrote to keychain" branch doesn't fail. The SQLite fallback
        // still kicks in via `cursor_provider_settings_io.rs`.
        Ok(())
    }
}

/// Delete the entry for `account`. Idempotent — clearing a missing
/// account is a no-op success.
pub fn delete_password(account: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        macos::delete_password(account)
    }
    #[cfg(target_os = "linux")]
    {
        keyring_backend::delete_password(account)
    }
    #[cfg(target_os = "windows")]
    {
        keyring_backend::delete_password(account)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = account;
        Ok(())
    }
}

/// `true` when the platform has a vault Helmor can use. All three
/// supported desktop targets (macOS / Linux / Windows) now have a
/// real backend; only "other" targets fall back to the SQLite
/// plaintext path.
pub fn has_vault_support() -> bool {
    cfg!(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "windows"
    ))
}

#[cfg(target_os = "macos")]
mod macos {
    use super::KEYCHAIN_SERVICE;
    use anyhow::{anyhow, Context, Result};
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    pub(super) fn read_password(account: &str) -> Result<Option<String>> {
        match get_generic_password(KEYCHAIN_SERVICE, account) {
            Ok(bytes) => {
                let text = std::str::from_utf8(&bytes)
                    .map_err(|err| anyhow!("keychain value is not utf-8: {err}"))?;
                Ok(Some(text.to_string()))
            }
            Err(err) => {
                // The crate returns a single `Error` type for all
                // failure modes. We need to distinguish "no entry"
                // (treated as Ok(None)) from anything else.
                let code = err.code();
                // `errSecItemNotFound` = -25300. Matches the only
                // error code we'd want to swallow.
                if code == -25_300 {
                    Ok(None)
                } else {
                    Err(anyhow::Error::new(err).context(format!(
                        "read keychain entry for service={KEYCHAIN_SERVICE} account={account}"
                    )))
                }
            }
        }
    }

    pub(super) fn write_password(account: &str, password: &str) -> Result<()> {
        set_generic_password(KEYCHAIN_SERVICE, account, password.as_bytes()).with_context(|| {
            format!("write keychain entry for service={KEYCHAIN_SERVICE} account={account}")
        })
    }

    pub(super) fn delete_password(account: &str) -> Result<()> {
        match delete_generic_password(KEYCHAIN_SERVICE, account) {
            Ok(()) => Ok(()),
            Err(err) if err.code() == -25_300 => Ok(()), // already gone
            Err(err) => Err(anyhow::Error::new(err).context(format!(
                "delete keychain entry for service={KEYCHAIN_SERVICE} account={account}"
            ))),
        }
    }
}

/// Cross-platform vault backend for Linux + Windows. Wraps the
/// `keyring` crate so a single code path serves both platforms; the
/// crate dispatches to secret-service on Linux and Credential Manager
/// on Windows under the hood. Compiled out on macOS (which keeps the
/// direct `security-framework` integration above).
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod keyring_backend {
    use super::KEYCHAIN_SERVICE;
    use anyhow::{Context, Result};
    use keyring::{Entry, Error as KeyringError};

    /// Distinguish "no entry exists for this account" from "the
    /// backend errored." `keyring` collapses platform-specific
    /// not-found signals (`errSecItemNotFound` on macOS, the
    /// `NoEntry` error on linux/secret-service, `ERROR_NOT_FOUND` on
    /// Windows) into a single variant; surfacing that as `Ok(None)`
    /// matches the contract `cursor::read_with_migration` expects.
    pub(super) fn read_password(account: &str) -> Result<Option<String>> {
        let entry = Entry::new(KEYCHAIN_SERVICE, account).with_context(|| {
            format!("build keyring entry for service={KEYCHAIN_SERVICE} account={account}")
        })?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(err) => Err(anyhow::Error::new(err).context(format!(
                "read keyring entry for service={KEYCHAIN_SERVICE} account={account}"
            ))),
        }
    }

    pub(super) fn write_password(account: &str, password: &str) -> Result<()> {
        let entry = Entry::new(KEYCHAIN_SERVICE, account).with_context(|| {
            format!("build keyring entry for service={KEYCHAIN_SERVICE} account={account}")
        })?;
        entry.set_password(password).with_context(|| {
            format!("write keyring entry for service={KEYCHAIN_SERVICE} account={account}")
        })
    }

    pub(super) fn delete_password(account: &str) -> Result<()> {
        let entry = Entry::new(KEYCHAIN_SERVICE, account).with_context(|| {
            format!("build keyring entry for service={KEYCHAIN_SERVICE} account={account}")
        })?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // Already deleted → idempotent success. Mirrors the
            // macOS branch's handling of errSecItemNotFound = -25300.
            Err(KeyringError::NoEntry) => Ok(()),
            Err(err) => Err(anyhow::Error::new(err).context(format!(
                "delete keyring entry for service={KEYCHAIN_SERVICE} account={account}"
            ))),
        }
    }
}

/// Cursor-specific façade: reads + writes the `apiKey` field of the
/// `app.cursor_provider` setting, with transparent migration from
/// the legacy SQLite plaintext storage.
///
/// Returns `Ok(None)` when neither the Keychain nor SQLite has a
/// value — that's the "first-run, no key configured" state.
pub fn read_cursor_api_key() -> Result<Option<String>> {
    cursor::read_with_migration(&DefaultCursorKeyBackend)
}

/// Write the Cursor API key. On macOS the key lands in Keychain +
/// the SQLite JSON value's `apiKey` field gets cleared (the rest of
/// the JSON config stays). On non-macOS the key stays in SQLite as
/// before.
///
/// `None` clears the key from both stores.
pub fn write_cursor_api_key(api_key: Option<&str>) -> Result<()> {
    cursor::write(&DefaultCursorKeyBackend, api_key)
}

/// Account name for the Cursor provider's key. Mirrored on the
/// frontend / settings flow so the JSON field name + the Keychain
/// account stay in lockstep.
pub const CURSOR_KEYCHAIN_ACCOUNT: &str = "cursor";

/// Storage backend for the Cursor key. The production impl wraps the
/// macOS Keychain (or no-ops on non-vault hosts); tests inject an
/// in-memory impl so the migration flow can be exercised
/// deterministically without touching the real Keychain.
pub trait CursorKeyBackend {
    fn supports_vault(&self) -> bool;
    fn read(&self) -> Result<Option<String>>;
    fn write(&self, value: &str) -> Result<()>;
    fn delete(&self) -> Result<()>;
    fn load_setting(&self) -> Result<Option<String>>;
    fn save_setting(&self, value: &str) -> Result<()>;
}

/// Production backend: macOS Keychain when available + the
/// app's SQLite settings table.
pub(crate) struct DefaultCursorKeyBackend;

impl CursorKeyBackend for DefaultCursorKeyBackend {
    fn supports_vault(&self) -> bool {
        has_vault_support()
    }
    fn read(&self) -> Result<Option<String>> {
        read_password(CURSOR_KEYCHAIN_ACCOUNT)
    }
    fn write(&self, value: &str) -> Result<()> {
        write_password(CURSOR_KEYCHAIN_ACCOUNT, value)
    }
    fn delete(&self) -> Result<()> {
        delete_password(CURSOR_KEYCHAIN_ACCOUNT)
    }
    fn load_setting(&self) -> Result<Option<String>> {
        crate::models::settings::load_setting_value(cursor::SETTING_KEY)
            .context("read app.cursor_provider")
    }
    fn save_setting(&self, value: &str) -> Result<()> {
        crate::models::settings::upsert_setting_value(cursor::SETTING_KEY, value)
    }
}

mod cursor {
    use super::CursorKeyBackend;
    use anyhow::{Context, Result};
    use serde_json::Value;

    pub(super) const SETTING_KEY: &str = "app.cursor_provider";

    pub(super) fn read_with_migration<B: CursorKeyBackend>(backend: &B) -> Result<Option<String>> {
        // Keychain wins when present.
        if backend.supports_vault() {
            if let Some(key) = backend.read()? {
                let trimmed = key.trim();
                if !trimmed.is_empty() {
                    return Ok(Some(trimmed.to_string()));
                }
            }
        }
        // Fall through to SQLite — either we're on a non-vault host
        // or the user upgraded from a release that wrote the key in
        // plaintext. Migrate on the way out.
        let Some(raw) = backend.load_setting()? else {
            return Ok(None);
        };
        let mut parsed: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => return Ok(None),
        };
        let sqlite_key = parsed
            .get("apiKey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        match (backend.supports_vault(), sqlite_key.as_deref()) {
            (true, Some(key)) => {
                // Migrate: copy to keychain, strip from SQLite.
                backend.write(key)?;
                if let Some(map) = parsed.as_object_mut() {
                    map.remove("apiKey");
                }
                if let Err(err) = backend.save_setting(&parsed.to_string()) {
                    tracing::warn!(
                        error = %format!("{err:#}"),
                        "keychain migration: write to keychain succeeded but clearing SQLite failed; the next read will re-migrate",
                    );
                }
                Ok(Some(key.to_string()))
            }
            _ => Ok(sqlite_key),
        }
    }

    pub(super) fn write<B: CursorKeyBackend>(backend: &B, api_key: Option<&str>) -> Result<()> {
        let trimmed = api_key.map(str::trim).filter(|s| !s.is_empty());
        if backend.supports_vault() {
            match trimmed {
                Some(key) => backend.write(key)?,
                None => backend.delete()?,
            }
            strip_api_key_from_sqlite(backend)
        } else {
            update_sqlite_api_key(backend, trimmed)
        }
    }

    fn strip_api_key_from_sqlite<B: CursorKeyBackend>(backend: &B) -> Result<()> {
        let Some(raw) = backend.load_setting()? else {
            return Ok(());
        };
        let mut parsed: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };
        let changed = parsed
            .as_object_mut()
            .map(|map| map.remove("apiKey").is_some())
            .unwrap_or(false);
        if changed {
            backend.save_setting(&parsed.to_string())?;
        }
        Ok(())
    }

    fn update_sqlite_api_key<B: CursorKeyBackend>(
        backend: &B,
        api_key: Option<&str>,
    ) -> Result<()> {
        let raw = backend.load_setting()?.unwrap_or_else(|| "{}".to_string());
        let mut parsed: Value =
            serde_json::from_str(&raw).unwrap_or(Value::Object(Default::default()));
        let map = parsed
            .as_object_mut()
            .context("app.cursor_provider must be a JSON object")?;
        match api_key {
            Some(key) => {
                map.insert("apiKey".to_string(), Value::String(key.to_string()));
            }
            None => {
                map.remove("apiKey");
            }
        }
        backend.save_setting(&parsed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn has_vault_support_covers_every_supported_desktop_target() {
        let expected = cfg!(any(
            target_os = "macos",
            target_os = "linux",
            target_os = "windows"
        ));
        assert_eq!(has_vault_support(), expected);
    }

    /// In-memory backend so the migration logic can be exercised
    /// without a real keychain or DB. Mirrors the production
    /// `DefaultCursorKeyBackend`: `vault` toggles whether
    /// `supports_vault()` returns true; `keychain` is the stored
    /// password (`Some(_)` after write); `setting` is the JSON
    /// blob persisted to "SQLite".
    struct InMemoryCursorBackend {
        vault: bool,
        keychain: RefCell<Option<String>>,
        setting: RefCell<Option<String>>,
    }

    impl InMemoryCursorBackend {
        fn new(vault: bool) -> Self {
            Self {
                vault,
                keychain: RefCell::new(None),
                setting: RefCell::new(None),
            }
        }
    }

    impl CursorKeyBackend for InMemoryCursorBackend {
        fn supports_vault(&self) -> bool {
            self.vault
        }
        fn read(&self) -> Result<Option<String>> {
            Ok(self.keychain.borrow().clone())
        }
        fn write(&self, value: &str) -> Result<()> {
            *self.keychain.borrow_mut() = Some(value.to_string());
            Ok(())
        }
        fn delete(&self) -> Result<()> {
            *self.keychain.borrow_mut() = None;
            Ok(())
        }
        fn load_setting(&self) -> Result<Option<String>> {
            Ok(self.setting.borrow().clone())
        }
        fn save_setting(&self, value: &str) -> Result<()> {
            *self.setting.borrow_mut() = Some(value.to_string());
            Ok(())
        }
    }

    #[test]
    fn returns_none_when_nothing_is_configured() {
        let backend = InMemoryCursorBackend::new(true);
        assert!(cursor::read_with_migration(&backend).unwrap().is_none());
    }

    #[test]
    fn reads_from_keychain_when_present() {
        let backend = InMemoryCursorBackend::new(true);
        backend.write("sk-live").unwrap();
        assert_eq!(
            cursor::read_with_migration(&backend).unwrap(),
            Some("sk-live".to_string()),
        );
        // SQLite stays untouched on a pure keychain hit.
        assert!(backend.setting.borrow().is_none());
    }

    #[test]
    fn migrates_sqlite_apikey_to_keychain_on_vault_host() {
        let backend = InMemoryCursorBackend::new(true);
        // Pre-seed SQLite with the legacy plaintext form.
        backend
            .save_setting(r#"{"apiKey":"sk-legacy","enabledModelIds":["x"]}"#)
            .unwrap();
        let result = cursor::read_with_migration(&backend).unwrap();
        assert_eq!(result, Some("sk-legacy".to_string()));
        // After migration: keychain has the key, SQLite no longer
        // does (but the non-sensitive config survives).
        assert_eq!(backend.keychain.borrow().as_deref(), Some("sk-legacy"),);
        let post: serde_json::Value =
            serde_json::from_str(backend.setting.borrow().as_deref().unwrap()).unwrap();
        assert!(
            post.get("apiKey").is_none(),
            "apiKey should be stripped: {post}"
        );
        assert_eq!(post["enabledModelIds"][0], "x");
    }

    #[test]
    fn falls_back_to_sqlite_apikey_on_non_vault_host() {
        let backend = InMemoryCursorBackend::new(false);
        backend.save_setting(r#"{"apiKey":"sk-legacy"}"#).unwrap();
        let result = cursor::read_with_migration(&backend).unwrap();
        assert_eq!(result, Some("sk-legacy".to_string()));
        // Non-vault: stays in SQLite, keychain empty.
        assert!(backend.keychain.borrow().is_none());
        let post: serde_json::Value =
            serde_json::from_str(backend.setting.borrow().as_deref().unwrap()).unwrap();
        assert_eq!(post["apiKey"], "sk-legacy");
    }

    #[test]
    fn write_routes_to_keychain_on_vault_host() {
        let backend = InMemoryCursorBackend::new(true);
        // Pre-seed SQLite with a residual apiKey to prove it gets stripped.
        backend
            .save_setting(r#"{"apiKey":"old","enabledModelIds":["x"]}"#)
            .unwrap();
        cursor::write(&backend, Some("sk-new")).unwrap();
        assert_eq!(backend.keychain.borrow().as_deref(), Some("sk-new"));
        let post: serde_json::Value =
            serde_json::from_str(backend.setting.borrow().as_deref().unwrap()).unwrap();
        assert!(post.get("apiKey").is_none());
        assert_eq!(post["enabledModelIds"][0], "x");
    }

    #[test]
    fn write_routes_to_sqlite_on_non_vault_host() {
        let backend = InMemoryCursorBackend::new(false);
        backend
            .save_setting(r#"{"enabledModelIds":["x"]}"#)
            .unwrap();
        cursor::write(&backend, Some("sk-new")).unwrap();
        // Non-vault: keychain empty, key in SQLite.
        assert!(backend.keychain.borrow().is_none());
        let post: serde_json::Value =
            serde_json::from_str(backend.setting.borrow().as_deref().unwrap()).unwrap();
        assert_eq!(post["apiKey"], "sk-new");
        assert_eq!(post["enabledModelIds"][0], "x");
    }

    #[test]
    fn write_none_clears_both_stores() {
        let backend = InMemoryCursorBackend::new(true);
        backend.write("seeded").unwrap();
        backend
            .save_setting(r#"{"apiKey":"seeded","enabledModelIds":["x"]}"#)
            .unwrap();
        cursor::write(&backend, None).unwrap();
        assert!(backend.keychain.borrow().is_none());
        let post: serde_json::Value =
            serde_json::from_str(backend.setting.borrow().as_deref().unwrap()).unwrap();
        assert!(post.get("apiKey").is_none());
        assert_eq!(post["enabledModelIds"][0], "x");
    }

    #[test]
    fn empty_or_whitespace_keys_are_treated_as_missing() {
        let backend = InMemoryCursorBackend::new(true);
        backend.write("   ").unwrap();
        assert!(cursor::read_with_migration(&backend).unwrap().is_none());
    }

    // The Linux + Windows backends talk to a real OS vault (D-Bus
    // secret-service / Credential Manager) — exercising them under
    // `cargo test` would require a session bus + a running keyring
    // daemon, which CI doesn't provide. The cross-platform unit
    // coverage lives on the in-memory `InMemoryCursorBackend` above;
    // the per-backend integration smoke is captured in the
    // architecture doc's "manual smoke test" section.
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    #[test]
    fn unsupported_target_keychain_helpers_no_op() {
        assert!(read_password("test").unwrap().is_none());
        write_password("test", "value").unwrap();
        delete_password("test").unwrap();
    }
}
