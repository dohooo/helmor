//! Deterministic startup core shared by the desktop GUI `setup()` hook and the
//! headless `helmor serve` host. Contains only the pure, runtime-agnostic
//! initialization (data dir, logging, DB schema, connection pools) — no Tauri
//! `AppHandle`, no background workers, no desktop-only wiring. Those stay with
//! their respective hosts.

use crate::{data_dir, db, logging, models, schema};

/// Initialise the deterministic startup core: data directory structure,
/// structured logging, database schema, and connection pools. Idempotent and
/// free of any runtime/`AppHandle` dependency, so both the desktop `setup()`
/// hook and the headless serve host can call it as their first step.
pub fn init_core() -> anyhow::Result<()> {
    // Ensure data directory structure exists
    data_dir::ensure_directory_structure()?;

    // Initialize structured logging (must come before any tracing macro call).
    // Logs live in `<data_dir>/logs/{rust,sidecar}.jsonl` with a `.1` backup;
    // the size-ring appender bounds disk use without a cleanup pass.
    let logs_dir = data_dir::logs_dir()?;
    logging::init(&logs_dir)?;

    // Initialize database schema. We apply the same PRAGMA init as
    // the pools to get WAL mode persisted to the file before any
    // pool connection opens.
    let db_path = data_dir::db_path()?;
    let connection = rusqlite::Connection::open(&db_path)?;
    db::init_connection(&connection, true)?;
    schema::ensure_schema(&connection)?;
    drop(connection);

    // Build read/write connection pools (must happen after schema).
    db::init_pools()?;

    // Refresh the synthetic chat repo's display name in case the
    // canonical value moved between releases. No-op for installs
    // that have never created a chat workspace (no row to update).
    if let Err(error) = models::repos::refresh_system_chat_repo_name_if_exists() {
        tracing::warn!(%error, "Failed to refresh chat repo name");
    }

    tracing::info!(
        mode = data_dir::data_mode_label(),
        data = %db_path.display(),
        "Helmor started"
    );

    Ok(())
}
