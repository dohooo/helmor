//! Extract Slack workspace credentials from the user's locally-installed
//! Slack desktop client.
//!
//! Why this exists alongside the EZ-Login webview path: when Slack
//! enforces extra auth (passkey, admin-mandated 2FA, SSO bounces),
//! re-doing the whole login flow inside an embedded webview is fragile
//! — Slack actively shifts those flows around. The desktop client has
//! already completed all of that, and the resulting `xoxc-…` token +
//! `d=xoxd-…` cookie live on disk. Reading them gives us instant
//! access to every workspace the user is already signed into,
//! regardless of what auth gate they passed.
//!
//! Steps (macOS only in v1; Windows/Linux paths sketched in TODOs):
//!   1. Find Slack's user-data dir (sandboxed Mac App Store vs.
//!      self-distributed builds).
//!   2. Open `Local Storage/leveldb/` read-only, iterate keys, find the
//!      `localConfig_v2` entry, decode the prefixed value, parse the
//!      JSON, pluck `xoxc-…` per team plus team metadata.
//!   3. Open `Cookies` (Chromium SQLite), read the `d` cookie's
//!      `encrypted_value` blob.
//!   4. Read the `Slack Safe Storage` Keychain entry to get the AES key
//!      material.
//!   5. PBKDF2-SHA1(key, salt=b"saltysalt", iters=1003, dkLen=16) →
//!      AES-128-CBC decrypt the cookie payload (after stripping the
//!      `v10`/`v11` Chromium version prefix). PKCS7-strip the result
//!      to get the `xoxd-…` string.
//!   6. Pair each team token with the same `d` cookie (the cookie is
//!      account-scoped, not workspace-scoped).
//!
//! References for the cookie scheme:
//!   - Chromium `os_crypt_mac.mm`
//!   - Electron `safeStorage` (same scheme as Chrome on macOS)
//!   - hraftery/slacktokens (Python reference implementation)

use std::path::{Path, PathBuf};

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockDecryptMut, KeyIvInit};
use anyhow::{anyhow, bail, Context, Result};
use rusqlite::OpenFlags;
use rusty_leveldb::LdbIterator;
use serde::{Deserialize, Serialize};

use super::credentials::SlackCreds;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

const KEYCHAIN_SERVICE: &str = "Slack Safe Storage";
const SAFE_STORAGE_SALT: &[u8] = b"saltysalt";
const SAFE_STORAGE_ITERATIONS: u32 = 1003;
const AES_KEY_LEN: usize = 16;
const CIPHER_PREFIX_V10: &[u8] = b"v10";
const CIPHER_PREFIX_V11: &[u8] = b"v11";

/// One Slack workspace the user is signed into on their desktop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredTeam {
    pub team_id: String,
    pub team_name: String,
    pub team_domain: String,
    pub creds: SlackCreds,
}

/// Top-level entry point. Returns every workspace whose token we could
/// successfully extract. Auth-test validation happens later in the IPC
/// layer so we don't make the disk-scrape itself slow / failable on
/// transient network errors.
pub fn scrape() -> Result<Vec<DiscoveredTeam>> {
    #[cfg(target_os = "macos")]
    {
        scrape_macos()
    }
    #[cfg(not(target_os = "macos"))]
    {
        bail!("Slack desktop import is only supported on macOS in this version")
    }
}

#[cfg(target_os = "macos")]
fn scrape_macos() -> Result<Vec<DiscoveredTeam>> {
    let data_dir = find_slack_data_dir()
        .context("Couldn't find Slack desktop's data directory — is Slack installed?")?;
    tracing::info!(slack_dir = %data_dir.display(), "Scraping Slack desktop session");

    let teams_from_leveldb =
        read_local_config_teams(&data_dir.join("Local Storage").join("leveldb")).context(
            "Couldn't read tokens from Slack's local storage. Try quitting Slack and trying again.",
        )?;

    if teams_from_leveldb.is_empty() {
        bail!("Slack desktop is installed but no signed-in workspaces were found");
    }

    let xoxd = read_d_cookie(&data_dir.join("Cookies"), &data_dir)
        .context("Couldn't read or decrypt Slack's session cookie")?;

    tracing::info!(
        team_count = teams_from_leveldb.len(),
        "Decrypted Slack creds"
    );
    let mut out = Vec::new();
    for team in teams_from_leveldb {
        out.push(DiscoveredTeam {
            team_id: team.team_id.clone(),
            team_name: team.team_name,
            team_domain: team.team_domain,
            creds: SlackCreds {
                xoxc: team.token,
                xoxd: xoxd.clone(),
            },
        });
    }
    Ok(out)
}

/// Copy every regular file out of `src` into `dst`, skipping the LOCK
/// file (rusty-leveldb refuses to open if a LOCK file already exists,
/// and we don't want to inherit Slack's lock anyway). Returns the list
/// of file names that were copied so the caller can surface them in
/// debug logs.
fn copy_leveldb_snapshot(src: &Path, dst: &Path) -> Result<Vec<String>> {
    let entries =
        std::fs::read_dir(src).with_context(|| format!("Couldn't list {}", src.display()))?;
    let mut copied = Vec::new();
    for entry in entries {
        let entry = entry?;
        let file_name = entry.file_name();
        if file_name == "LOCK" {
            continue;
        }
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }
        std::fs::copy(entry.path(), dst.join(&file_name))
            .with_context(|| format!("Couldn't copy {:?} into {}", file_name, dst.display()))?;
        copied.push(file_name.to_string_lossy().into_owned());
    }
    Ok(copied)
}

#[cfg(target_os = "macos")]
fn find_slack_data_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    // Slack ships two macOS builds with different data dirs:
    //   - Mac App Store (sandboxed): ~/Library/Containers/com.tinyspeck.slackmacgap/...
    //   - Standalone direct download:  ~/Library/Application Support/Slack
    // A user can have BOTH on disk if they tried one then switched. The
    // one Slack is actually using is the one whose Cookies file was
    // touched most recently. Pick by mtime, not by "first that exists"
    // — getting this wrong means reading 6-month-old creds and every
    // call returns invalid_auth.
    let candidates = [
        home.join("Library/Application Support/Slack"),
        home.join(
            "Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack",
        ),
    ];
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }
        // Cookies is the most reliable freshness indicator — Slack
        // updates it on every session refresh. Fall back to the
        // directory mtime if Cookies hasn't been created yet.
        let mtime = std::fs::metadata(candidate.join("Cookies"))
            .or_else(|_| std::fs::metadata(&candidate))
            .and_then(|m| m.modified())
            .ok();
        let Some(mtime) = mtime else { continue };
        match &best {
            Some((_, prev_mtime)) if *prev_mtime >= mtime => {}
            _ => best = Some((candidate, mtime)),
        }
    }
    best.map(|(p, _)| p)
}

/// Standalone Slack stores its Safe Storage key under
/// account="Slack"; Mac App Store stores it under account="Slack App
/// Store Key". We probe both, matching candidate order — but use the
/// data-dir's path shape to bias which one to try first so a fresh
/// keychain prompt only fires for the right account.
#[cfg(target_os = "macos")]
fn keychain_accounts_for(data_dir: &Path) -> &'static [&'static str] {
    if data_dir
        .to_string_lossy()
        .contains("com.tinyspeck.slackmacgap")
    {
        // Sandboxed Mac App Store build first.
        &["Slack App Store Key", "Slack"]
    } else {
        // Standalone build first.
        &["Slack", "Slack App Store Key"]
    }
}

/// Parsed entry inside `localConfig_v2.teams.<team_id>`.
#[derive(Debug, Clone)]
struct TeamFromLeveldb {
    team_id: String,
    team_name: String,
    team_domain: String,
    token: String,
}

/// Read the `localConfig_v2` Local Storage entry and pluck the token /
/// metadata for every team the user is signed into.
///
/// Chromium's Local Storage leveldb layout:
///   - key `META:<origin>` → per-origin metadata (we ignore this)
///   - key `_<origin>\x00\x01<storage_key>` → the actual stringified
///     value, with a 1-byte encoding prefix (0x01 = UTF-16 LE,
///     0x00 = Latin-1) followed by the payload.
///
/// Slack's `localConfig_v2` value is JSON of shape:
///   `{ "teams": { "<TID>": { "token": "xoxc-…", "id": "<TID>", "name": "...", "domain": "...", ... } } }`
///
/// Important: Slack desktop holds an exclusive lock on the leveldb
/// while it's running. We copy the directory to a temp location before
/// opening so the user doesn't have to quit Slack first.
fn read_local_config_teams(leveldb_dir: &Path) -> Result<Vec<TeamFromLeveldb>> {
    if !leveldb_dir.exists() {
        bail!(
            "Slack Local Storage dir not found at {}",
            leveldb_dir.display()
        );
    }

    // Snapshot the leveldb dir to a temp location so we don't fight
    // Slack desktop for the LOCK file. The whole working set is
    // typically a few MB — cheap. The TempDir is dropped at the end of
    // this function so the copy doesn't linger on disk (note: when an
    // open fails we surface the dir path so a developer can inspect
    // it; that requires turning off auto-delete on that branch).
    let snapshot = tempfile::Builder::new()
        .prefix("helmor-slack-leveldb-")
        .tempdir()
        .context("Failed to create tempdir for Slack leveldb snapshot")?;
    let copied = copy_leveldb_snapshot(leveldb_dir, snapshot.path()).with_context(|| {
        format!(
            "Failed to snapshot Slack Local Storage from {} into {}",
            leveldb_dir.display(),
            snapshot.path().display()
        )
    })?;
    tracing::info!(
        snapshot_dir = %snapshot.path().display(),
        file_count = copied.len(),
        files = ?copied,
        "Snapshotted Slack leveldb",
    );

    let open_result = rusty_leveldb::DB::open(
        snapshot.path(),
        rusty_leveldb::Options {
            create_if_missing: false,
            paranoid_checks: false,
            ..Default::default()
        },
    );

    let mut db = match open_result {
        Ok(db) => db,
        Err(error) => {
            // Persist the snapshot so a developer can inspect what was
            // copied vs. what rusty-leveldb expected. Probe the
            // surfaces rusty-leveldb relies on so we can see exactly
            // which read failed.
            let kept = snapshot.keep();
            let current = kept.join("CURRENT");
            let current_metadata = std::fs::metadata(&current);
            let current_contents = std::fs::read_to_string(&current);
            let manifest_listing: Vec<String> = std::fs::read_dir(&kept)
                .map(|rd| {
                    rd.filter_map(|e| e.ok())
                        .map(|e| e.file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default();
            tracing::error!(
                kept_dir = %kept.display(),
                error = %error,
                current_exists = current.exists(),
                current_metadata = ?current_metadata,
                current_contents = ?current_contents,
                manifest_listing = ?manifest_listing,
                "rusty-leveldb open failed",
            );
            return Err(anyhow!(
                "Failed to open Slack Local Storage snapshot at {} (kept for inspection): {error}",
                kept.display()
            ));
        }
    };

    let mut iter = db.new_iter().context("leveldb iter init failed")?;
    let mut raw_json: Option<String> = None;
    let mut k = Vec::new();
    let mut v = Vec::new();
    while iter.advance() {
        iter.current(&mut k, &mut v);
        if !key_is_local_config(&k) {
            continue;
        }
        match decode_local_storage_value(&v) {
            Ok(decoded) => {
                raw_json = Some(decoded);
                break;
            }
            Err(error) => {
                tracing::warn!(error = %error, "localConfig_v2 value decode failed; continuing");
            }
        }
    }

    let json_text =
        raw_json.ok_or_else(|| anyhow!("localConfig_v2 entry not found in Slack Local Storage"))?;
    parse_teams_json(&json_text)
}

fn key_is_local_config(key: &[u8]) -> bool {
    // The full key looks like `_https://app.slack.com\x00\x01localConfig_v2`.
    // Match the suffix and require the slack.com origin somewhere in
    // the front so we don't pick up unrelated entries.
    let needle_suffix = b"localConfig_v2";
    let needle_origin = b"slack.com";
    if !key.ends_with(needle_suffix) {
        return false;
    }
    key.windows(needle_origin.len())
        .any(|window| window == needle_origin)
}

/// Strip Chromium's 1-byte encoding prefix and decode the payload.
///
/// Chromium's Local Storage value encoding is documented in
/// `services/storage/dom_storage/local_storage_impl.cc` and has
/// changed across versions:
///   - Older builds: `0x00` = Latin-1/UTF-8, `0x01` = UTF-16 LE
///   - Current builds (incl. the one Slack desktop ships):
///     `0x00` and `0x01` are both sometimes followed by UTF-8 —
///     verified empirically against Slack's `localConfig_v2`
///     payload, which has prefix `0x01` and an odd-length UTF-8
///     ASCII JSON body.
///
/// We try UTF-8 first regardless of the prefix byte (it's the common
/// case and never produces a false positive on JSON). UTF-16 LE
/// fallback covers any non-ASCII-heavy entries we might encounter
/// later. Empty / single-byte values are treated as empty strings
/// so iteration can keep going.
fn decode_local_storage_value(value: &[u8]) -> Result<String> {
    if value.len() < 2 {
        return Ok(String::new());
    }
    let body = &value[1..];
    if let Ok(s) = std::str::from_utf8(body) {
        return Ok(s.to_string());
    }
    if body.len().is_multiple_of(2) {
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        if let Ok(s) = String::from_utf16(&units) {
            return Ok(s);
        }
    }
    bail!("local storage value isn't valid UTF-8 or UTF-16 LE");
}

fn parse_teams_json(json_text: &str) -> Result<Vec<TeamFromLeveldb>> {
    let root: serde_json::Value =
        serde_json::from_str(json_text).context("localConfig_v2 isn't valid JSON")?;
    let teams_obj = root
        .get("teams")
        .and_then(|v| v.as_object())
        .ok_or_else(|| anyhow!("localConfig_v2 has no `teams` object"))?;
    let mut out = Vec::new();
    for (key, entry) in teams_obj {
        let Some(team) = entry.as_object() else {
            continue;
        };
        let token = team
            .get("token")
            .and_then(|v| v.as_str())
            .filter(|s| s.starts_with("xoxc-"));
        let Some(token) = token else {
            // Some entries in `teams` are stale (signed-out workspaces)
            // that no longer carry a token. Skip silently.
            continue;
        };
        let team_id = team
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or(key)
            .to_string();
        let team_name = team
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&team_id)
            .to_string();
        let team_domain = team
            .get("domain")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        out.push(TeamFromLeveldb {
            team_id,
            team_name,
            team_domain,
            token: token.to_string(),
        });
    }
    Ok(out)
}

/// Read `d` from Slack's Cookies SQLite and decrypt it.
#[cfg(target_os = "macos")]
fn read_d_cookie(cookies_path: &Path, data_dir: &Path) -> Result<String> {
    if !cookies_path.exists() {
        bail!("Slack Cookies file not found at {}", cookies_path.display());
    }
    let conn = rusqlite::Connection::open_with_flags(
        cookies_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| {
        format!(
            "Failed to open Slack Cookies DB at {}",
            cookies_path.display()
        )
    })?;

    let (host_key, encrypted): (String, Vec<u8>) = conn
        .query_row(
            "SELECT host_key, encrypted_value FROM cookies
               WHERE name = 'd' AND host_key LIKE '%slack.com'
               ORDER BY length(encrypted_value) DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .context("No `d` cookie row found in Slack Cookies DB")?;

    let key = read_safe_storage_key(data_dir)
        .context("Couldn't read Slack's Safe Storage key from the macOS Keychain")?;
    let xoxd = decrypt_chromium_cookie(&encrypted, &key, host_key.as_bytes())
        .context("Failed to decrypt Slack `d` cookie")?;
    Ok(xoxd)
}

#[cfg(target_os = "macos")]
fn read_safe_storage_key(data_dir: &Path) -> Result<Vec<u8>> {
    // The Slack desktop client stores its Safe Storage AES key in the
    // user's login Keychain. We could go through the `keyring` crate,
    // but that returns "No matching entry found" — the Keychain
    // item's ACL is restricted to the binaries Slack itself signed,
    // so a direct Security Framework lookup from Helmor gets blocked.
    //
    // Shelling out to `/usr/bin/security` works because the user gets
    // a one-time "Allow Helmor to access Slack Safe Storage?" prompt
    // and macOS remembers the approval. The user explicitly clicked
    // "Import from Slack desktop", so an extra OS-level confirmation
    // is acceptable UX.
    let accounts = keychain_accounts_for(data_dir);
    let mut last_err: Option<String> = None;
    for account in accounts {
        match try_read_keychain_password(account) {
            Ok(key) if !key.is_empty() => return Ok(key),
            Ok(_) => last_err = Some(format!("{account}: empty")),
            Err(error) => last_err = Some(format!("{account}: {error}")),
        }
    }
    bail!(
        "Slack Safe Storage key not found in Keychain (tried {:?}): {}",
        accounts,
        last_err.unwrap_or_default()
    )
}

#[cfg(target_os = "macos")]
fn try_read_keychain_password(account: &str) -> Result<Vec<u8>> {
    let output = std::process::Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-ws",
            KEYCHAIN_SERVICE,
            "-a",
            account,
        ])
        .output()
        .context("Failed to spawn /usr/bin/security")?;
    if !output.status.success() {
        bail!(
            "`security` exit={:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let mut key = output.stdout;
    // `security -w` writes a trailing newline after the value; strip
    // it so PBKDF2 sees the exact password bytes.
    if key.last() == Some(&b'\n') {
        key.pop();
    }
    Ok(key)
}

/// Chromium / Electron `safeStorage` decryption for cookie blobs.
///
/// Layout: `<3-byte version prefix v10/v11><ciphertext>`. The
/// ciphertext is AES-128-CBC of the original UTF-8 plaintext, padded
/// with PKCS7. Key derivation: PBKDF2-SHA1 over the Safe Storage
/// password with salt `"saltysalt"`, 1003 iterations (macOS-specific),
/// dkLen = 16 bytes. IV is fixed at 16 bytes of ASCII space (0x20).
fn decrypt_chromium_cookie(payload: &[u8], password: &[u8], host_key: &[u8]) -> Result<String> {
    use sha2::{Digest, Sha256};

    if payload.len() < 4 {
        bail!(
            "encrypted cookie payload is too short ({} bytes)",
            payload.len()
        );
    }
    let prefix = &payload[..3];
    if prefix != CIPHER_PREFIX_V10 && prefix != CIPHER_PREFIX_V11 {
        bail!(
            "unexpected Chromium cipher prefix {prefix:?} — Slack may be encrypting with a scheme we don't support yet"
        );
    }
    let ciphertext = &payload[3..];

    let mut key = [0u8; AES_KEY_LEN];
    pbkdf2::pbkdf2::<hmac::Hmac<sha1::Sha1>>(
        password,
        SAFE_STORAGE_SALT,
        SAFE_STORAGE_ITERATIONS,
        &mut key,
    )
    .map_err(|err| anyhow!("PBKDF2 failed: {err}"))?;

    let iv: [u8; 16] = [b' '; 16];
    let mut buf = ciphertext.to_vec();
    let plaintext = Aes128CbcDec::new(&key.into(), &iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|err| anyhow!("AES-CBC decrypt failed: {err}"))?;

    // Chromium v94+ prepends `SHA256(host_key)` (32 bytes) to the
    // plaintext before encryption as a domain-binding mitigation
    // against decrypted-cookie cross-domain replay. Older builds (and
    // the sandboxed Mac App Store Slack we tested earlier) didn't do
    // this — so we detect the prefix instead of always stripping 32
    // bytes. If the leading bytes match `SHA256(host_key)`, strip them.
    let expected_hash = Sha256::digest(host_key);
    let plaintext_value: &[u8] = if plaintext.len() >= 32 && plaintext[..32] == expected_hash[..] {
        &plaintext[32..]
    } else {
        plaintext
    };

    let s = std::str::from_utf8(plaintext_value)
        .context("decrypted cookie is not valid UTF-8")?
        .to_string();
    Ok(s)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    #[test]
    fn key_is_local_config_matches_real_slack_keys() {
        let key = b"_https://app.slack.com\x00\x01localConfig_v2";
        assert!(key_is_local_config(key));
    }

    #[test]
    fn key_is_local_config_rejects_unrelated_keys() {
        assert!(!key_is_local_config(b"META:https://app.slack.com"));
        assert!(!key_is_local_config(
            b"_https://example.com\x00\x01localConfig_v2"
        ));
        assert!(!key_is_local_config(
            b"_https://app.slack.com\x00\x01otherKey"
        ));
    }

    #[test]
    fn decode_local_storage_value_handles_utf8_with_prefix_zero() {
        let mut v = vec![0x00];
        v.extend_from_slice(b"{\"hello\":1}");
        assert_eq!(decode_local_storage_value(&v).unwrap(), "{\"hello\":1}");
    }

    #[test]
    fn decode_local_storage_value_handles_utf8_with_prefix_one() {
        // Real Slack localConfig_v2 carries prefix=0x01 followed by
        // UTF-8 ASCII JSON (verified by reading actual Slack desktop
        // leveldb in dev). Make sure we don't insist on UTF-16 just
        // because the byte says "0x01".
        let mut v = vec![0x01];
        v.extend_from_slice(b"{\"teams\":{}}");
        assert_eq!(decode_local_storage_value(&v).unwrap(), "{\"teams\":{}}");
    }

    #[test]
    fn decode_local_storage_value_falls_back_to_utf16_when_utf8_invalid() {
        let mut v = vec![0x01];
        // 0xff 0xff is invalid UTF-8 but valid UTF-16 LE (U+FFFF).
        v.extend_from_slice(&u16::to_le_bytes(0xFFFF));
        v.extend_from_slice(&u16::to_le_bytes(b'h' as u16));
        let decoded = decode_local_storage_value(&v).unwrap();
        assert!(decoded.ends_with('h'));
    }

    #[test]
    fn parse_teams_json_extracts_token_id_name_domain() {
        let json = r#"{
            "teams": {
                "T111": {"id":"T111","name":"Team One","domain":"team-one","token":"xoxc-aaa"},
                "T222": {"id":"T222","name":"Team Two","domain":"team-two","token":"xoxc-bbb"},
                "T333": {"id":"T333","name":"Signed Out"}
            }
        }"#;
        let teams = parse_teams_json(json).unwrap();
        let mut by_id: HashMap<_, _> = teams.into_iter().map(|t| (t.team_id.clone(), t)).collect();
        assert_eq!(by_id.len(), 2);
        let t1 = by_id.remove("T111").unwrap();
        assert_eq!(t1.team_name, "Team One");
        assert_eq!(t1.team_domain, "team-one");
        assert_eq!(t1.token, "xoxc-aaa");
        let t2 = by_id.remove("T222").unwrap();
        assert_eq!(t2.token, "xoxc-bbb");
    }

    #[test]
    fn decrypt_chromium_cookie_round_trip() {
        // Encrypt a known plaintext with the same scheme used by Chromium
        // on macOS, then assert our decrypt recovers it.
        use aes::cipher::block_padding::Pkcs7;
        use aes::cipher::{BlockEncryptMut, KeyIvInit};
        type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

        let password = b"unit-test-key";
        let plaintext = b"xoxd-abcdef-1234567890";

        let mut key = [0u8; AES_KEY_LEN];
        pbkdf2::pbkdf2::<hmac::Hmac<sha1::Sha1>>(
            password,
            SAFE_STORAGE_SALT,
            SAFE_STORAGE_ITERATIONS,
            &mut key,
        )
        .unwrap();
        let iv: [u8; 16] = [b' '; 16];
        let mut buf = vec![0u8; plaintext.len() + 16];
        buf[..plaintext.len()].copy_from_slice(plaintext);
        let ct = Aes128CbcEnc::new(&key.into(), &iv.into())
            .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
            .unwrap();
        let mut payload = Vec::with_capacity(3 + ct.len());
        payload.extend_from_slice(CIPHER_PREFIX_V10);
        payload.extend_from_slice(ct);

        // Pass any host_key; the test plaintext doesn't start with its
        // SHA256, so the optional strip is a no-op.
        let recovered = decrypt_chromium_cookie(&payload, password, b".slack.com").unwrap();
        assert_eq!(recovered, "xoxd-abcdef-1234567890");
    }

    #[test]
    fn decrypt_chromium_cookie_strips_sha256_host_key_prefix() {
        // Chromium v94+ on macOS prepends sha256(host_key) to plaintext
        // pre-encryption. Verify our strip handles it.
        use aes::cipher::block_padding::Pkcs7;
        use aes::cipher::{BlockEncryptMut, KeyIvInit};
        use sha2::{Digest, Sha256};
        type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

        let password = b"unit-test-key";
        let host = b".slack.com";
        let payload_value = b"xoxd-abcdef-1234567890";
        // Plaintext that Chromium builds: sha256(host) || value
        let mut plaintext = Sha256::digest(host).to_vec();
        plaintext.extend_from_slice(payload_value);

        let mut key = [0u8; AES_KEY_LEN];
        pbkdf2::pbkdf2::<hmac::Hmac<sha1::Sha1>>(
            password,
            SAFE_STORAGE_SALT,
            SAFE_STORAGE_ITERATIONS,
            &mut key,
        )
        .unwrap();
        let iv: [u8; 16] = [b' '; 16];
        let mut buf = vec![0u8; plaintext.len() + 16];
        buf[..plaintext.len()].copy_from_slice(&plaintext);
        let ct = Aes128CbcEnc::new(&key.into(), &iv.into())
            .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
            .unwrap();
        let mut payload = Vec::with_capacity(3 + ct.len());
        payload.extend_from_slice(CIPHER_PREFIX_V10);
        payload.extend_from_slice(ct);

        let recovered = decrypt_chromium_cookie(&payload, password, host).unwrap();
        assert_eq!(recovered, "xoxd-abcdef-1234567890");
    }
}
