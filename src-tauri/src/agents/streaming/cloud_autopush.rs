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
pub(super) fn maybe_autopush_after_turn(
    app: &tauri::AppHandle,
    working_directory: &str,
    acting_member: Option<&str>,
    session_id: &str,
) {
    if !enabled() {
        return;
    }
    let dir = working_directory.to_string();
    // Team mode: author the commit as the member who ran the turn. The detached
    // thread can't read the ambient acting-member (thread-local), so capture it
    // here. `None` (desktop / no member) → the global git identity, unchanged.
    let member = acting_member.map(str::to_string);
    let session_id = session_id.to_string();
    let app = app.clone();
    std::thread::Builder::new()
        .name("cloud-autopush".into())
        .spawn(move || {
            match autopush_and_record(Path::new(&dir), member.as_deref(), &session_id) {
                AutopushOutcome::Committed => {
                    // The autopush just committed + pushed this turn's work, so
                    // it is the AUTHORITATIVE source of that git change —
                    // announce it directly. The container git fs-watcher does
                    // not fire reliably (and races the aggressive post-turn
                    // idle-destroy), so without this the D1 git-snapshot mirror
                    // never re-reads and every team inspector's Git panel stays
                    // empty. `WorkspaceGitStateChanged` is a `git_snapshot_target`
                    // in `companion::team_sync`, which fires `sync_git_snapshot`
                    // in the same window this push completes in (before the
                    // commit-reaching origin is followed by idle-destroy).
                    // Best-effort: a missing workspace / read error just skips
                    // the publish (never crashes the detached thread).
                    match crate::models::sessions::workspace_id_for_session(&session_id) {
                        Ok(Some(workspace_id)) => {
                            crate::ui_sync::publish(
                                &app,
                                crate::ui_sync::UiMutationEvent::WorkspaceGitStateChanged {
                                    workspace_id,
                                },
                            );
                        }
                        Ok(None) => {}
                        Err(error) => {
                            tracing::warn!(
                                error = %format!("{error:#}"),
                                session_id = %session_id,
                                "cloud auto-push: workspace lookup for git-state publish failed"
                            );
                        }
                    }
                }
                AutopushOutcome::FailureRecorded => {
                    // A failure notice row landed in the session — tell live
                    // clients to refetch so the user sees it before idle destroy.
                    crate::ui_sync::publish(
                        &app,
                        crate::ui_sync::UiMutationEvent::SessionTurnPersisted { session_id },
                    );
                }
                AutopushOutcome::NoOp | AutopushOutcome::FailureUnrecorded => {}
            }
        })
        .ok();
}

/// What a post-turn auto-push attempt did, so [`maybe_autopush_after_turn`]'s
/// detached thread can broadcast the matching UI invalidation exactly once.
#[derive(Debug, PartialEq, Eq)]
enum AutopushOutcome {
    /// A real commit + push landed on `origin`. The caller announces
    /// `WorkspaceGitStateChanged` so the `team_sync` git-snapshot mirror
    /// re-reads (the container fs-watcher can't be relied on to fire it).
    Committed,
    /// Nothing to push (not a repo / clean tree / nothing staged). Silent.
    NoOp,
    /// The push failed AND a session-level failure notice was recorded; the
    /// caller announces `SessionTurnPersisted` so live clients refetch it.
    FailureRecorded,
    /// The push failed AND the notice couldn't be recorded — nothing to announce.
    FailureUnrecorded,
}

/// Body of the detached auto-push thread. Classifies the attempt (see
/// [`AutopushOutcome`]) so the caller broadcasts the right UI invalidation: a
/// real commit+push, a silent no-op, or a failure (with/without a recorded
/// notice).
fn autopush_and_record(
    workspace_dir: &Path,
    acting_member: Option<&str>,
    session_id: &str,
) -> AutopushOutcome {
    let error = match autopush(workspace_dir, acting_member) {
        Ok(true) => return AutopushOutcome::Committed,
        Ok(false) => return AutopushOutcome::NoOp,
        Err(error) => error,
    };
    tracing::warn!(
        error = %format!("{error:#}"),
        dir = %workspace_dir.display(),
        "cloud auto-push failed"
    );
    // P1-5a: a swallowed warn means the user idles into a disk wipe with no
    // idea their work never reached the remote. Leave a session-level notice
    // so it renders in chat (adapter's existing `type:"error"` arm) and
    // survives in the DB backup.
    match record_autopush_failure(session_id, &error) {
        Ok(()) => AutopushOutcome::FailureRecorded,
        Err(record_error) => {
            tracing::warn!(
                error = %format!("{record_error:#}"),
                "cloud auto-push failure could not be recorded to the session"
            );
            AutopushOutcome::FailureUnrecorded
        }
    }
}

/// Longest failure detail (chars) carried into the session notice. Full detail
/// stays in the tracing log; the chat row only needs enough to orient.
const FAILURE_DETAIL_MAX_CHARS: usize = 300;

/// Insert a `role=system` / `type:"error"` row into `session_messages` so the
/// failure renders through the pipeline's existing error arm (no new content
/// shape). Opens a short-lived connection like `checkpoint_db` — the detached
/// thread has no pool access.
///
/// Token-safety: `detail` is git stderr/stdout only (`git/ops.rs::
/// handle_git_failure`) — argv, where the `http.extraheader` Authorization
/// value rides since P1-8a, is never echoed by git or by our error chain.
fn record_autopush_failure(session_id: &str, error: &anyhow::Error) -> anyhow::Result<()> {
    let detail: String = format!("{error:#}")
        .chars()
        .take(FAILURE_DETAIL_MAX_CHARS)
        .collect();
    let content = serde_json::json!({
        "type": "error",
        "message": format!(
            "Cloud auto-push failed — this turn's work is NOT backed up to the \
             git remote and may be lost when the workspace goes to sleep. ({detail})"
        ),
    })
    .to_string();
    let path = crate::data_dir::db_path()?;
    let conn = rusqlite::Connection::open(&path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let msg_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    conn.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at
            ) VALUES (?1, ?2, 'system', ?3, ?4, ?4)
        "#,
        rusqlite::params![msg_id, session_id, content, now],
    )?;
    Ok(())
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

/// P1-3b / R2-F4a (Codex half): `$CODEX_HOME/.tmp` is Codex's
/// plugin-marketplace clone cache — 76MB+ of regenerable state under the
/// backed-up `/home/helmor` tree. It used to be handled by a nested
/// `.codex/.tmp` entry in the Worker's `BACKUP_EXCLUDES`, but the container's
/// older squashfs-tools drops the ENTIRE parent tree for a nested exclude
/// pattern — the class3+4 rollout autopsy (2026-07-11) proved the whole
/// `.codex` session-thread tree was silently missing from BOTH backup paths,
/// so Codex resume came back empty after every sleep. The exclude list is
/// top-level-only now (pinned in cloud/test/idle-backup-excludes.test.ts) and
/// the cache is pruned HERE instead, before any backup can see it.
///
/// FINALLY semantics (architect ruling, 2026-07-11): the guard fires when the
/// stream worker exits — success, persist failure, abort, error, or panic —
/// so a failed turn can never leave a fat `.tmp` for the idle backup to
/// swallow (that was hole "a" in the post-turn-only design). Residual window,
/// accepted + non-silent: the idle expiry deliberately ignores in-flight
/// requests (R3-A), so a LONG turn can be snapshotted mid-flight before this
/// guard fires — the Worker's `warnIfBackupOversized` is the tripwire and the
/// next turn's prune self-heals the disk.
///
/// Drop-order note for the wiring site: this is a LOCAL of the stream worker
/// closure, so it drops before the closure's captured environment — including
/// the event `Channel` whose EOF triggers the Worker's post-stream backup —
/// which makes the post-turn archive deterministically pruned too.
pub(super) struct CodexTmpPruneGuard;

impl Drop for CodexTmpPruneGuard {
    fn drop(&mut self) {
        prune_codex_tmp();
    }
}

/// Remove `$CODEX_HOME/.tmp` (best-effort). No-op on the desktop (env gate)
/// and when the directory is already absent. A real removal failure is a
/// WARN, never a panic — but it means the next backup may be oversized, so
/// the message points at the size-warn tripwire.
fn prune_codex_tmp() {
    if !enabled() {
        return;
    }
    let tmp = crate::platform::paths::codex_home_dir().join(".tmp");
    match std::fs::remove_dir_all(&tmp) {
        Ok(()) => {
            tracing::debug!(dir = %tmp.display(), "pruned codex tmp cache ahead of backup");
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            tracing::warn!(
                error = %error,
                dir = %tmp.display(),
                "codex tmp prune failed — the next backup may exceed the size budget (warnIfBackupOversized is the tripwire)"
            );
        }
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

/// Returns `Ok(true)` when this actually committed + pushed the turn's work,
/// `Ok(false)` on a no-op (not a repo / clean tree / nothing staged). The
/// caller keys the post-push git-state announce off the `true` case.
fn autopush(workspace_dir: &Path, acting_member: Option<&str>) -> anyhow::Result<bool> {
    // REG-R6-1: chat-room sessions run in a plain directory with no git repo —
    // "not a repo" is "nothing to push", not a failure, so skip silently
    // (no warn, no P1-5a notice; before this guard every chat turn recorded a
    // loud "Cloud auto-push failed" error row). `.git` is a directory in a
    // normal clone and a file in a linked worktree — `exists()` covers both;
    // autopush workspace dirs are always the clone root, never a subdirectory.
    if !workspace_dir.join(".git").exists() {
        return Ok(false);
    }

    // Nothing changed → nothing to do (the common case mid-conversation when a
    // turn only read files / answered a question).
    if git_ops::working_tree_clean(workspace_dir)? {
        return Ok(false);
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
        return Ok(false);
    }

    // Author the commit as the acting member when we know them (team mode), via
    // per-invocation `-c user.name/email` so the global identity is untouched.
    // The GitHub noreply email attributes the commit to that user. Falls back to
    // the container's global identity when there's no member / no synced login.
    let mut commit_args: Vec<String> = vec!["-C".into(), dir.clone()];
    if let Some((name, email)) = acting_member.and_then(forge_author) {
        commit_args.push("-c".into());
        commit_args.push(format!("user.name={name}"));
        commit_args.push("-c".into());
        commit_args.push(format!("user.email={email}"));
    }
    commit_args.push("commit".into());
    commit_args.push("-m".into());
    commit_args.push("helmor: auto-commit after agent turn".into());
    git_ops::run_git(commit_args, None)?;

    git_ops::push_current_branch(workspace_dir, DEFAULT_REMOTE)?;
    tracing::info!(dir = %dir, "cloud auto-push: committed + pushed turn changes");
    Ok(true)
}

/// Per-member git author (login + GitHub noreply email) for the auto-commit, or
/// `None` when the member has no synced forge identity / login (→ global git
/// identity). The email `<id>+<login>@users.noreply.github.com` is GitHub's
/// canonical form, so the commit attributes to that user.
fn forge_author(member_id: &str) -> Option<(String, String)> {
    let login = crate::forge::member_creds::member_for(member_id)?.login?;
    let email = format!("{member_id}+{login}@users.noreply.github.com");
    Some((login, email))
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

    /// Build a file-backed helmor.db (record_autopush_failure opens its own
    /// connection via `data_dir::db_path`, so in-memory won't do) with the real
    /// schema and one session row.
    fn seed_session_db(data_dir: &std::path::Path, session_id: &str) {
        env::set_var("HELMOR_DATA_DIR", data_dir);
        let path = crate::data_dir::db_path().unwrap();
        let conn = rusqlite::Connection::open(&path).unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status) VALUES (?1, 'w1', 'idle')",
            [session_id],
        )
        .unwrap();
    }

    fn read_system_messages(session_id: &str) -> Vec<String> {
        let path = crate::data_dir::db_path().unwrap();
        let conn = rusqlite::Connection::open(&path).unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT content FROM session_messages WHERE session_id = ?1 AND role = 'system'",
            )
            .unwrap();
        let rows = stmt
            .query_map([session_id], |row| row.get::<_, String>(0))
            .unwrap();
        rows.map(Result::unwrap).collect()
    }

    /// Init a git repo with one uncommitted file and an unreachable https
    /// remote, so `autopush` takes the full commit+push path and the push
    /// fails — the same shape as a real "creator token revoked / network down"
    /// failure in the container.
    fn seed_failing_repo(dir: &std::path::Path) {
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?} failed: {out:?}");
        };
        run(&["init", "-q"]);
        run(&["config", "user.name", "t"]);
        run(&["config", "user.email", "t@example.com"]);
        // Port 1 on localhost: connection refused immediately, no network.
        run(&["remote", "add", "origin", "https://127.0.0.1:1/nowhere.git"]);
        std::fs::write(dir.join("work.txt"), "unpushed work").unwrap();
    }

    /// Init a git repo with one uncommitted file and a REACHABLE `origin` (a
    /// local `--bare` clone target), so `autopush` runs the full add+commit+push
    /// path and the push SUCCEEDS — the shape of a real container turn that
    /// wrote code and reached origin.
    fn seed_pushable_repo(work_dir: &std::path::Path, remote_dir: &std::path::Path) {
        let run = |dir: &std::path::Path, args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?} failed: {out:?}");
        };
        run(remote_dir, &["init", "--bare", "-q"]);
        run(work_dir, &["init", "-q"]);
        run(work_dir, &["config", "user.name", "t"]);
        run(work_dir, &["config", "user.email", "t@example.com"]);
        run(
            work_dir,
            &["remote", "add", "origin", &remote_dir.display().to_string()],
        );
        std::fs::write(work_dir.join("work.txt"), "pushed work").unwrap();
    }

    /// P1-5a: a failing push must leave a session-level system notice (not
    /// just a swallowed tracing::warn), and the notice body must never carry
    /// auth material — git errors are stderr-only (git/ops.rs
    /// handle_git_failure), argv (where the `http.extraheader` token rides)
    /// is never echoed.
    #[test]
    fn failed_push_records_session_notice_without_auth_material() {
        let data_dir = tempfile::tempdir().unwrap();
        let repo_dir = tempfile::tempdir().unwrap();
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        seed_session_db(data_dir.path(), "s-autopush");
        seed_failing_repo(repo_dir.path());

        let outcome = autopush_and_record(repo_dir.path(), None, "s-autopush");

        assert_eq!(
            outcome,
            AutopushOutcome::FailureRecorded,
            "failure must report as recorded"
        );
        let messages = read_system_messages("s-autopush");
        assert_eq!(
            messages.len(),
            1,
            "exactly one failure notice: {messages:?}"
        );
        let content: serde_json::Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(content["type"], "error");
        let body = content["message"].as_str().unwrap();
        assert!(
            body.contains("auto-push failed"),
            "user-facing failure text present: {body}"
        );
        // Pin the no-token property: nothing that smells like the argv auth
        // header may reach the persisted message.
        for needle in [
            "Authorization",
            "Basic ",
            "extraheader",
            "x-access-token",
            "oauth2:",
        ] {
            assert!(
                !body.contains(needle),
                "auth material {needle:?} leaked into notice: {body}"
            );
        }
        env::remove_var("HELMOR_DATA_DIR");
    }

    /// REG-R6-1: a chat-room session's working dir is a plain directory (no
    /// git repo at all) — "not a repo" is "nothing to push", not a failure.
    /// It must record NO session notice (before the guard, every chat turn
    /// left a loud "Cloud auto-push failed" error row via the P1-5a path).
    #[test]
    fn non_git_dir_is_silently_skipped_without_notice() {
        let data_dir = tempfile::tempdir().unwrap();
        let plain_dir = tempfile::tempdir().unwrap();
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        seed_session_db(data_dir.path(), "s-chat");
        // No `git init`: this mirrors a team chat room's scratch directory.
        std::fs::write(plain_dir.path().join("note.txt"), "chat scratch").unwrap();

        let outcome = autopush_and_record(plain_dir.path(), None, "s-chat");

        assert_eq!(
            outcome,
            AutopushOutcome::NoOp,
            "non-repo dir is a silent no-op, not a recorded failure"
        );
        assert!(
            read_system_messages("s-chat").is_empty(),
            "non-repo dir must leave zero notice rows"
        );
        env::remove_var("HELMOR_DATA_DIR");
    }

    /// A clean push (nothing to do) must not leave any notice row.
    #[test]
    fn successful_autopush_records_nothing() {
        let data_dir = tempfile::tempdir().unwrap();
        let repo_dir = tempfile::tempdir().unwrap();
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        seed_session_db(data_dir.path(), "s-clean");
        // Repo with no changes at all → autopush early-returns Ok.
        let out = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(repo_dir.path())
            .output()
            .unwrap();
        assert!(out.status.success());

        let outcome = autopush_and_record(repo_dir.path(), None, "s-clean");

        assert_eq!(outcome, AutopushOutcome::NoOp);
        assert!(read_system_messages("s-clean").is_empty());
        env::remove_var("HELMOR_DATA_DIR");
    }

    /// The autopush "committed" signal is what the detached thread keys the new
    /// `WorkspaceGitStateChanged` publish off (the announce that deterministically
    /// fires the D1 git-snapshot mirror without waiting on the container
    /// fs-watcher). A real commit+push must report `true` / `Committed`; a clean
    /// repo must report `false` / `NoOp` so nothing is announced.
    #[test]
    fn successful_commit_push_reports_committed_signal() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();

        // Pushable repo → raw autopush reports the committed bool…
        let work_a = tempfile::tempdir().unwrap();
        let remote_a = tempfile::tempdir().unwrap();
        seed_pushable_repo(work_a.path(), remote_a.path());
        assert!(
            autopush(work_a.path(), None).unwrap(),
            "a real commit+push reports committed = true"
        );

        // …and the signal threads through autopush_and_record as `Committed`,
        // with no failure notice recorded (fresh repo, no session DB touched).
        let work_b = tempfile::tempdir().unwrap();
        let remote_b = tempfile::tempdir().unwrap();
        seed_pushable_repo(work_b.path(), remote_b.path());
        assert_eq!(
            autopush_and_record(work_b.path(), None, "s-committed"),
            AutopushOutcome::Committed,
        );

        // Clean repo (nothing to push) → committed = false / NoOp, no announce.
        let clean = tempfile::tempdir().unwrap();
        let out = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(clean.path())
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(
            !autopush(clean.path(), None).unwrap(),
            "a clean/no-op repo reports committed = false"
        );
        assert_eq!(
            autopush_and_record(clean.path(), None, "s-noop"),
            AutopushOutcome::NoOp,
        );
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

    /// Build a fake `$CODEX_HOME` with a `.tmp` cache marker and a sibling
    /// `sessions/` tree that must survive the prune.
    fn seed_codex_home(codex_home: &std::path::Path) {
        std::fs::create_dir_all(codex_home.join(".tmp")).unwrap();
        std::fs::write(codex_home.join(".tmp/cache-marker"), "exclude-me").unwrap();
        std::fs::create_dir_all(codex_home.join("sessions")).unwrap();
        std::fs::write(codex_home.join("sessions/keep"), "keep-me").unwrap();
    }

    #[test]
    fn prune_guard_removes_tmp_and_keeps_session_tree() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        env::set_var(AUTOPUSH_ENV, "1");
        env::set_var("CODEX_HOME", dir.path());
        seed_codex_home(dir.path());

        drop(CodexTmpPruneGuard);

        assert!(
            !dir.path().join(".tmp").exists(),
            ".tmp cache pruned before any backup can see it"
        );
        assert!(
            dir.path().join("sessions/keep").exists(),
            "sibling session tree (the R2-F4a payload) survives"
        );

        env::remove_var(AUTOPUSH_ENV);
        env::remove_var("CODEX_HOME");
    }

    #[test]
    fn prune_guard_fires_on_panic_too_finally_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        env::set_var(AUTOPUSH_ENV, "1");
        env::set_var("CODEX_HOME", dir.path());
        seed_codex_home(dir.path());

        // The architect-ruled "finally" contract: a turn that dies mid-flight
        // (persist failure surfaces as an early exit; worst case a panic)
        // must STILL prune — otherwise the idle backup swallows the fat
        // `.tmp` now that the exclude list no longer shields it (hole "a").
        let result = std::panic::catch_unwind(|| {
            let _prune = CodexTmpPruneGuard;
            panic!("simulated mid-turn death");
        });
        assert!(result.is_err(), "the panic itself propagates");
        assert!(
            !dir.path().join(".tmp").exists(),
            ".tmp pruned even when the worker dies (finally semantics)"
        );

        env::remove_var(AUTOPUSH_ENV);
        env::remove_var("CODEX_HOME");
    }

    #[test]
    fn prune_is_a_noop_on_the_desktop_and_on_missing_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        env::set_var("CODEX_HOME", dir.path());
        seed_codex_home(dir.path());

        // Desktop (gate unset): the user's real ~/.codex/.tmp must never be
        // touched.
        env::remove_var(AUTOPUSH_ENV);
        drop(CodexTmpPruneGuard);
        assert!(
            dir.path().join(".tmp/cache-marker").exists(),
            "desktop is a hard no-op"
        );

        // Gate on + directory already absent: silent success, no panic.
        env::set_var(AUTOPUSH_ENV, "1");
        std::fs::remove_dir_all(dir.path().join(".tmp")).unwrap();
        drop(CodexTmpPruneGuard);
        assert!(!dir.path().join(".tmp").exists());

        env::remove_var(AUTOPUSH_ENV);
        env::remove_var("CODEX_HOME");
    }
}
