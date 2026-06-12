//! Persistence for mobile-companion paired devices.
//!
//! A row holds only a SHA-256 of the PAT (never the plaintext) plus a label and
//! timestamps. The PAT is shown once at pairing time (in the QR) and lives on
//! the phone thereafter. Fixed-link rows survive desktop restarts; temporary
//! rows are revoked when the desktop connection they point at goes away.

use anyhow::Result;
use base64::Engine;
use rusqlite::params;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::models::db;

const PENDING_TTL: Duration = Duration::from_secs(10 * 60);

static PENDING_PAIRINGS: OnceLock<Mutex<HashMap<String, PendingPairing>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionKind {
    Temporary,
    Fixed,
}

impl ConnectionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Temporary => "temporary",
            Self::Fixed => "fixed",
        }
    }
}

impl From<&str> for ConnectionKind {
    fn from(value: &str) -> Self {
        match value {
            "fixed" => Self::Fixed,
            _ => Self::Temporary,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub label: String,
    pub created_at: String,
    pub last_seen_at: Option<String>,
    pub connection_kind: ConnectionKind,
}

pub struct PendingPairingPayload {
    pub device_id: String,
    pub label: String,
    pub pat: String,
    pub connection_kind: ConnectionKind,
}

pub struct PatVerification {
    pub valid: bool,
    pub promoted: bool,
}

struct PendingPairing {
    id: String,
    label: String,
    connection_kind: ConnectionKind,
    created_at: Instant,
}

/// Create a device: generate a PAT, persist its hash, return the row plus the
/// one-time plaintext PAT (the only time it exists outside the phone).
pub fn create_paired_device(label: &str) -> Result<(PairedDevice, String)> {
    let pat = generate_pat();
    let id = uuid::Uuid::new_v4().to_string();
    let now = db::current_timestamp()?;
    let conn = db::write_conn()?;
    conn.execute(
        "INSERT INTO paired_devices (id, label, pat_hash, created_at, connection_kind) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, label, hash_pat(&pat), now, ConnectionKind::Temporary.as_str()],
    )?;
    Ok((
        PairedDevice {
            id,
            label: label.to_string(),
            created_at: now,
            last_seen_at: None,
            connection_kind: ConnectionKind::Temporary,
        },
        pat,
    ))
}

/// Create a short-lived pairing token without writing a device row yet. The row
/// is created only once the phone uses the token against the companion server.
pub fn create_pending_pairing(
    label: &str,
    replace_device_id: Option<&str>,
    connection_kind: ConnectionKind,
) -> PendingPairingPayload {
    let pat = generate_pat();
    let id = uuid::Uuid::new_v4().to_string();
    let mut pending = pending_pairings().lock().unwrap_or_else(|e| e.into_inner());
    purge_expired_pending(&mut pending);
    if let Some(replace_id) = replace_device_id {
        pending.retain(|_, item| item.id != replace_id);
    }
    pending.insert(
        hash_pat(&pat),
        PendingPairing {
            id: id.clone(),
            label: label.to_string(),
            connection_kind,
            created_at: Instant::now(),
        },
    );
    PendingPairingPayload {
        device_id: id,
        label: label.to_string(),
        pat,
        connection_kind,
    }
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

/// Verify a PAT, promoting a still-pending pairing token into a real paired
/// device on first use.
pub fn verify_or_pair_and_touch(pat: &str) -> Result<PatVerification> {
    if verify_and_touch(pat)? {
        return Ok(PatVerification {
            valid: true,
            promoted: false,
        });
    }

    let pat_hash = hash_pat(pat);
    let pending = {
        let mut pending = pending_pairings().lock().unwrap_or_else(|e| e.into_inner());
        purge_expired_pending(&mut pending);
        pending.remove(&pat_hash)
    };

    let Some(pending) = pending else {
        return Ok(PatVerification {
            valid: false,
            promoted: false,
        });
    };

    let now = db::current_timestamp()?;
    let conn = db::write_conn()?;
    conn.execute(
        "INSERT INTO paired_devices (id, label, pat_hash, created_at, last_seen_at, connection_kind) \
         VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        params![
            pending.id,
            pending.label,
            pat_hash,
            now,
            pending.connection_kind.as_str()
        ],
    )?;
    Ok(PatVerification {
        valid: true,
        promoted: true,
    })
}

/// List active (non-revoked) devices, newest first.
pub fn list_paired_devices() -> Result<Vec<PairedDevice>> {
    let conn = db::read_conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, label, created_at, last_seen_at, connection_kind FROM paired_devices \
         WHERE revoked_at IS NULL AND last_seen_at IS NOT NULL ORDER BY created_at DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            let connection_kind: String = row.get(4)?;
            Ok(PairedDevice {
                id: row.get(0)?,
                label: row.get(1)?,
                created_at: row.get(2)?,
                last_seen_at: row.get(3)?,
                connection_kind: ConnectionKind::from(connection_kind.as_str()),
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

pub fn revoke_devices_by_connection_kind(connection_kind: ConnectionKind) -> Result<usize> {
    let now = db::current_timestamp()?;
    let conn = db::write_conn()?;
    let updated = conn.execute(
        "UPDATE paired_devices SET revoked_at = ?1 WHERE connection_kind = ?2 AND revoked_at IS NULL",
        params![now, connection_kind.as_str()],
    )?;
    Ok(updated)
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

fn pending_pairings() -> &'static Mutex<HashMap<String, PendingPairing>> {
    PENDING_PAIRINGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn purge_expired_pending(pending: &mut HashMap<String, PendingPairing>) {
    let now = Instant::now();
    pending.retain(|_, item| now.duration_since(item.created_at) <= PENDING_TTL);
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
        assert_eq!(list[0].connection_kind, ConnectionKind::Temporary);
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

    #[test]
    fn pending_pairing_promotes_with_connection_kind() {
        let _env = crate::testkit::TestEnv::new("paired-devices-pending-kind");

        let temporary = create_pending_pairing("iPhone", None, ConnectionKind::Temporary);
        let fixed = create_pending_pairing("iPad", None, ConnectionKind::Fixed);

        let temporary_result = verify_or_pair_and_touch(&temporary.pat).unwrap();
        assert!(temporary_result.valid);
        assert!(temporary_result.promoted);

        let fixed_result = verify_or_pair_and_touch(&fixed.pat).unwrap();
        assert!(fixed_result.valid);
        assert!(fixed_result.promoted);

        let list = list_paired_devices().unwrap();
        assert_eq!(list.len(), 2);
        let temporary_row = list.iter().find(|d| d.id == temporary.device_id).unwrap();
        let fixed_row = list.iter().find(|d| d.id == fixed.device_id).unwrap();
        assert_eq!(temporary_row.connection_kind, ConnectionKind::Temporary);
        assert_eq!(fixed_row.connection_kind, ConnectionKind::Fixed);
    }

    #[test]
    fn revoke_by_connection_kind_only_revokes_matching_devices() {
        let _env = crate::testkit::TestEnv::new("paired-devices-revoke-kind");

        let temporary = create_pending_pairing("iPhone", None, ConnectionKind::Temporary);
        let fixed = create_pending_pairing("iPad", None, ConnectionKind::Fixed);
        assert!(verify_or_pair_and_touch(&temporary.pat).unwrap().valid);
        assert!(verify_or_pair_and_touch(&fixed.pat).unwrap().valid);

        let revoked = revoke_devices_by_connection_kind(ConnectionKind::Temporary).unwrap();
        assert_eq!(revoked, 1);

        assert!(!verify_or_pair_and_touch(&temporary.pat).unwrap().valid);
        assert!(verify_or_pair_and_touch(&fixed.pat).unwrap().valid);
        let list = list_paired_devices().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].connection_kind, ConnectionKind::Fixed);
    }
}
