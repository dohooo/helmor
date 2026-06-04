//! Persistence for mobile-companion paired devices.
//!
//! A row holds only a SHA-256 of the PAT (never the plaintext) plus a label and
//! timestamps. The PAT is shown once at pairing time (in the QR) and lives on
//! the phone thereafter. Rows survive desktop restarts, so a paired phone never
//! re-scans.

use anyhow::Result;
use base64::Engine;
use rusqlite::params;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::models::db;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub label: String,
    pub created_at: String,
    pub last_seen_at: Option<String>,
}

/// Create a device: generate a PAT, persist its hash, return the row plus the
/// one-time plaintext PAT (the only time it exists outside the phone).
pub fn create_paired_device(label: &str) -> Result<(PairedDevice, String)> {
    let pat = generate_pat();
    let id = uuid::Uuid::new_v4().to_string();
    let now = db::current_timestamp()?;
    let conn = db::write_conn()?;
    conn.execute(
        "INSERT INTO paired_devices (id, label, pat_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, label, hash_pat(&pat), now],
    )?;
    Ok((
        PairedDevice {
            id,
            label: label.to_string(),
            created_at: now,
            last_seen_at: None,
        },
        pat,
    ))
}

/// Verify a PAT against the non-revoked devices, bumping `last_seen_at` on a
/// match. Returns true when the PAT is valid.
pub fn verify_and_touch(pat: &str) -> Result<bool> {
    let now = db::current_timestamp()?;
    let conn = db::write_conn()?;
    let updated = conn.execute(
        "UPDATE paired_devices SET last_seen_at = ?1 WHERE pat_hash = ?2 AND revoked_at IS NULL",
        params![now, hash_pat(pat)],
    )?;
    Ok(updated > 0)
}

/// List active (non-revoked) devices, newest first.
pub fn list_paired_devices() -> Result<Vec<PairedDevice>> {
    let conn = db::read_conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, label, created_at, last_seen_at FROM paired_devices \
         WHERE revoked_at IS NULL ORDER BY created_at DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(PairedDevice {
                id: row.get(0)?,
                label: row.get(1)?,
                created_at: row.get(2)?,
                last_seen_at: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Revoke a single device. Its PAT stops authenticating immediately.
pub fn revoke_paired_device(id: &str) -> Result<()> {
    let now = db::current_timestamp()?;
    let conn = db::write_conn()?;
    conn.execute(
        "UPDATE paired_devices SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
        params![now, id],
    )?;
    Ok(())
}

fn generate_pat() -> String {
    let bytes: [u8; 32] = rand::random();
    format!(
        "hlm_{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    )
}

fn hash_pat(pat: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(pat.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_verify_list_revoke_roundtrip() {
        let _env = crate::testkit::TestEnv::new("paired-devices");

        let (device, pat) = create_paired_device("Pixel").unwrap();
        assert!(pat.starts_with("hlm_"));
        assert_eq!(device.label, "Pixel");

        // Valid PAT authenticates; a wrong one does not.
        assert!(verify_and_touch(&pat).unwrap());
        assert!(!verify_and_touch("hlm_wrong").unwrap());

        // Listed once, with last_seen_at now populated by verify.
        let list = list_paired_devices().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, device.id);
        assert!(list[0].last_seen_at.is_some());

        // After revoke: PAT rejected and row hidden from the list.
        revoke_paired_device(&device.id).unwrap();
        assert!(!verify_and_touch(&pat).unwrap());
        assert!(list_paired_devices().unwrap().is_empty());
    }

    #[test]
    fn pat_plaintext_is_never_stored() {
        let _env = crate::testkit::TestEnv::new("paired-devices-hash");
        let (_device, pat) = create_paired_device("iPhone").unwrap();
        let conn = db::read_conn().unwrap();
        let stored: String = conn
            .query_row("SELECT pat_hash FROM paired_devices LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_ne!(stored, pat);
        assert_eq!(stored.len(), 64); // SHA-256 hex
    }
}
