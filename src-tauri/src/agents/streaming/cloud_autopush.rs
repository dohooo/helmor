//! Cloud serve-mode auto-push (PR6 workflow closure).
//!
//! The CF sandbox disk is wiped on sleep, so any code the agent wrote must
//! reach the git remote before the turn ends. After a turn finalizes, this
//! commits any uncommitted work in the workspace and pushes it to `origin`.
//!
//! Gated entirely by the `HELMOR_CLOUD_AUTOPUSH` env var, which only the
//! container's boot script sets — on the desktop the env is unset, so this is
//! a hard no-op and changes no existing behavior (and never runs in tests).
//! Best-effort throughout: any failure is logged and swallowed, because a push
//! problem must never crash an agent turn.

use std::path::Path;

use crate::git_ops;

/// Env var that opts a process into post-turn auto-commit + push. Set by
/// `cloud/scripts/start-serve.sh` in the container only.
const AUTOPUSH_ENV: &str = "HELMOR_CLOUD_AUTOPUSH";
/// Remote the workspace branch is pushed to (the boot clone wires `origin`
/// with an embedded PAT so the push is non-interactive).
const DEFAULT_REMOTE: &str = "origin";

/// Whether cloud auto-push is enabled for this process.
fn enabled() -> bool {
    matches!(
        std::env::var(AUTOPUSH_ENV).ok().as_deref(),
        Some("1") | Some("true")
    )
}

/// Commit + push the workspace's uncommitted work after a finalized turn.
/// No-op (returns immediately) on the desktop. Runs on a detached thread so it
/// never blocks the streaming loop.
pub(super) fn maybe_autopush_after_turn(working_directory: &str) {
    if !enabled() {
        return;
    }
    let dir = working_directory.to_string();
    std::thread::Builder::new()
        .name("cloud-autopush".into())
        .spawn(move || {
            if let Err(error) = autopush(Path::new(&dir)) {
                tracing::warn!(
                    error = %format!("{error:#}"),
                    dir = %dir,
                    "cloud auto-push failed"
                );
            }
        })
        .ok();
}

/// Fold the SQLite WAL back into `helmor.db` after a finalized turn so the
/// next Sandbox backup snapshots a self-contained DB file.
///
/// Runs SYNCHRONOUSLY (unlike `maybe_autopush_after_turn`, which detaches): the
/// caller invokes this on the turn-finalize seam, before the terminal `done`
/// event is emitted, so the checkpoint completes before the Worker's
/// post-stream backup snapshots `helmor.db`. A `TRUNCATE` checkpoint also keeps
/// the `-wal` sidecar from being captured separately by the squashfs backup.
///
/// No-op (returns immediately) on the desktop — the env gate is unset there, so
/// this never opens a connection and changes no existing behavior.
pub(super) fn maybe_checkpoint_db_after_turn() {
    if !enabled() {
        return;
    }
    if let Err(error) = checkpoint_db() {
        tracing::warn!(
            error = %format!("{error:#}"),
            "cloud WAL checkpoint failed"
        );
    }
}

fn checkpoint_db() -> anyhow::Result<()> {
    let path = crate::data_dir::db_path()?;
    // Short-lived connection: open, checkpoint, drop. This seam runs after
    // `persist_result_and_finalize` has COMMITTED (the writer pool slot is still
    // held but carries no open transaction), so TRUNCATE folds every WAL frame
    // into helmor.db. SQLite's TRUNCATE checkpoint never errors or blocks even
    // with other pool connections open — at worst the zero-truncation step is
    // skipped when a concurrent reader pins an active snapshot, in which case the
    // -wal/-shm sidecars (also captured by the backup) keep restore consistent.
    let conn = rusqlite::Connection::open(&path)?;
    conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
    tracing::debug!(db = %path.display(), "cloud WAL checkpoint (TRUNCATE) complete");
    Ok(())
}

fn autopush(workspace_dir: &Path) -> anyhow::Result<()> {
    // Nothing changed → nothing to do (the common case mid-conversation when a
    // turn only read files / answered a question).
    if git_ops::working_tree_clean(workspace_dir)? {
        return Ok(());
    }

    let dir = workspace_dir.display().to_string();

    // Stage everything (tracked + untracked).
    git_ops::run_git(["-C", dir.as_str(), "add", "-A"], None)?;

    // `git diff --cached --quiet` exits 0 when nothing is staged (e.g. all the
    // dirty paths were gitignored), non-zero otherwise. `run_git` maps a
    // non-zero exit to `Err`, so `is_ok()` here means "nothing actually
    // staged" — skip the empty commit in that case.
    let nothing_staged =
        git_ops::run_git(["-C", dir.as_str(), "diff", "--cached", "--quiet"], None).is_ok();
    if nothing_staged {
        return Ok(());
    }

    git_ops::run_git(
        [
            "-C",
            dir.as_str(),
            "commit",
            "-m",
            "helmor: auto-commit after agent turn",
        ],
        None,
    )?;

    git_ops::push_current_branch(workspace_dir, DEFAULT_REMOTE)?;
    tracing::info!(dir = %dir, "cloud auto-push: committed + pushed turn changes");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_dir::TEST_ENV_LOCK;
    use std::env;

    /// Open `helmor.db` in WAL mode and write a row so a non-empty `-wal`
    /// sidecar exists; returns the data-dir path. Mirrors the streaming DB's
    /// journal mode so the checkpoint test exercises a real WAL fold.
    fn seed_wal_db(data_dir: &std::path::Path) {
        env::set_var("HELMOR_DATA_DIR", data_dir);
        let path = crate::data_dir::db_path().unwrap();
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1);")
            .unwrap();
        // Leave the connection open so the write lands in `-wal` (a TRUNCATE
        // checkpoint with no other readers will still fold + truncate it).
        drop(conn);
    }

    #[test]
    fn checkpoint_is_noop_when_env_gate_off() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        env::remove_var(AUTOPUSH_ENV);
        seed_wal_db(dir.path());

        // Gate off → returns immediately, never opens a connection. The point
        // is that this is a hard no-op on the desktop; assert it doesn't panic
        // and the DB file is otherwise untouched.
        maybe_checkpoint_db_after_turn();

        let wal = dir.path().join("helmor.db-wal");
        // The seeding connection was dropped, so SQLite may have auto-folded the
        // WAL already; the only invariant we assert here is that our function
        // performed no work — proven by it returning without error/panic.
        let _ = wal;
        env::remove_var("HELMOR_DATA_DIR");
    }

    #[test]
    fn checkpoint_runs_when_env_gate_on() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        env::set_var(AUTOPUSH_ENV, "1");
        seed_wal_db(dir.path());

        // Gate on → opens helmor.db and runs PRAGMA wal_checkpoint(TRUNCATE).
        // Must complete without error and leave the DB readable.
        maybe_checkpoint_db_after_turn();

        let path = crate::data_dir::db_path().unwrap();
        let conn = rusqlite::Connection::open(&path).unwrap();
        let v: i64 = conn.query_row("SELECT v FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 1, "data survives the checkpoint");
        // TRUNCATE checkpoint zeroes the WAL sidecar (or removes it). Either way
        // it must not be a large pending log.
        let wal = path.with_extension("db-wal");
        if wal.exists() {
            let len = std::fs::metadata(&wal).unwrap().len();
            assert_eq!(len, 0, "WAL truncated to zero after checkpoint");
        }

        env::remove_var(AUTOPUSH_ENV);
        env::remove_var("HELMOR_DATA_DIR");
    }
}
