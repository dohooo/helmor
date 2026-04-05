//! Workspace-granular import of Conductor data into Helmor.
//!
//! Users browse Conductor repos/workspaces, select individual workspaces,
//! and import both database records and filesystem context files.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::models::{git_ops, helpers};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A repository found in the Conductor database.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConductorRepo {
    pub id: String,
    pub name: String,
    pub remote_url: Option<String>,
    pub workspace_count: i64,
    pub already_imported_count: i64,
}

/// A workspace found in the Conductor database.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConductorWorkspace {
    pub id: String,
    pub directory_name: String,
    pub state: String,
    pub branch: Option<String>,
    pub derived_status: Option<String>,
    pub pr_title: Option<String>,
    pub session_count: i64,
    pub message_count: i64,
    pub already_imported: bool,
}

/// Result returned to the frontend after an import attempt.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportWorkspacesResult {
    pub success: bool,
    pub imported_count: i64,
    pub skipped_count: i64,
    pub errors: Vec<String>,
}

// ---------------------------------------------------------------------------
// Browsing — list repos and workspaces from Conductor
// ---------------------------------------------------------------------------

/// List all repositories in the Conductor database with workspace counts.
pub fn list_conductor_repos() -> Result<Vec<ConductorRepo>> {
    let (helmor_conn, _source_path) = open_with_conductor_attached()?;

    let mut stmt = helmor_conn
        .prepare(
            r#"
            SELECT
                r.id,
                r.name,
                r.remote_url,
                (SELECT count(*) FROM source.workspaces w
                 WHERE w.repository_id = r.id
                   AND w.state IN ('ready', 'archived')) AS workspace_count,
                (SELECT count(*) FROM source.workspaces w
                 WHERE w.repository_id = r.id
                   AND w.state IN ('ready', 'archived')
                   AND w.id IN (SELECT id FROM main.workspaces)) AS already_imported_count
            FROM source.repos r
            WHERE r.hidden = 0 OR r.hidden IS NULL
            ORDER BY r.name COLLATE NOCASE
            "#,
        )
        .context("Failed to query Conductor repos")?;

    let repos = stmt
        .query_map([], |row| {
            Ok(ConductorRepo {
                id: row.get(0)?,
                name: row.get(1)?,
                remote_url: row.get(2)?,
                workspace_count: row.get(3)?,
                already_imported_count: row.get(4)?,
            })
        })
        .context("Failed to read Conductor repos")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("Failed to collect Conductor repos")?;

    drop(stmt);

    helmor_conn.execute("DETACH DATABASE source", []).ok();

    Ok(repos)
}

/// List workspaces for a given repo in the Conductor database.
pub fn list_conductor_workspaces(repo_id: &str) -> Result<Vec<ConductorWorkspace>> {
    let (helmor_conn, _source_path) = open_with_conductor_attached()?;

    let mut stmt = helmor_conn
        .prepare(
            r#"
            SELECT
                w.id,
                w.directory_name,
                w.state,
                w.branch,
                w.derived_status,
                w.pr_title,
                (SELECT count(*) FROM source.sessions s
                 WHERE s.workspace_id = w.id) AS session_count,
                (SELECT count(*) FROM source.session_messages m
                 WHERE m.session_id IN (
                     SELECT s.id FROM source.sessions s WHERE s.workspace_id = w.id
                 )) AS message_count,
                (CASE WHEN w.id IN (SELECT id FROM main.workspaces) THEN 1 ELSE 0 END) AS already_imported
            FROM source.workspaces w
            WHERE w.repository_id = ?1
              AND w.state IN ('ready', 'archived')
            ORDER BY w.updated_at DESC
            "#,
        )
        .context("Failed to query Conductor workspaces")?;

    let workspaces = stmt
        .query_map([repo_id], |row| {
            Ok(ConductorWorkspace {
                id: row.get(0)?,
                directory_name: row.get(1)?,
                state: row.get(2)?,
                branch: row.get(3)?,
                derived_status: row.get(4)?,
                pr_title: row.get(5)?,
                session_count: row.get(6)?,
                message_count: row.get(7)?,
                already_imported: row.get::<_, i64>(8)? != 0,
            })
        })
        .context("Failed to read Conductor workspaces")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("Failed to collect Conductor workspaces")?;

    helmor_conn.execute("DETACH DATABASE source", []).ok();

    Ok(workspaces)
}

// ---------------------------------------------------------------------------
// Import — copy selected workspaces into Helmor
// ---------------------------------------------------------------------------

/// Import selected workspaces from Conductor into Helmor.
///
/// For each workspace:
/// 1. Copies database records (repo, workspace, sessions, messages, attachments, diff_comments)
/// 2. Copies filesystem context files (notes, todos, plans, attachments)
/// 3. Rewrites attachment paths to Helmor's data directory
pub fn import_conductor_workspaces(workspace_ids: &[String]) -> Result<ImportWorkspacesResult> {
    if workspace_ids.is_empty() {
        return Ok(ImportWorkspacesResult {
            success: true,
            imported_count: 0,
            skipped_count: 0,
            errors: vec![],
        });
    }

    let (helmor_conn, _source_path) = open_with_conductor_attached()?;

    let conductor_root = crate::data_dir::conductor_root_path();
    let helmor_data_dir = crate::data_dir::data_dir()?;

    let mut imported_count: i64 = 0;
    let mut skipped_count: i64 = 0;
    let mut errors: Vec<String> = vec![];

    // Phase 1: Import DB records in a transaction.
    // Git and filesystem operations happen in Phase 2 (after commit).
    helmor_conn
        .execute_batch("BEGIN IMMEDIATE")
        .context("Failed to start transaction")?;

    // Collect workspace metadata for Phase 2
    let mut imported_workspaces: Vec<ImportedWorkspaceMeta> = vec![];

    for ws_id in workspace_ids {
        // Savepoint per workspace so a partial failure rolls back only this workspace's rows
        helmor_conn.execute_batch("SAVEPOINT ws_import").ok();

        match import_workspace_db_records(&helmor_conn, ws_id) {
            Ok(ImportDbResult::Imported(meta)) => {
                helmor_conn
                    .execute_batch("RELEASE SAVEPOINT ws_import")
                    .ok();
                imported_workspaces.push(meta);
                imported_count += 1;
            }
            Ok(ImportDbResult::Skipped) => {
                helmor_conn
                    .execute_batch("RELEASE SAVEPOINT ws_import")
                    .ok();
                skipped_count += 1;
            }
            Err(error) => {
                helmor_conn
                    .execute_batch("ROLLBACK TO SAVEPOINT ws_import")
                    .ok();
                helmor_conn
                    .execute_batch("RELEASE SAVEPOINT ws_import")
                    .ok();
                errors.push(format!("{ws_id}: {error}"));
            }
        }
    }

    if imported_count > 0 || skipped_count > 0 {
        helmor_conn
            .execute_batch("COMMIT")
            .context("Failed to commit")?;
    } else {
        helmor_conn.execute_batch("ROLLBACK").ok();
    }

    helmor_conn.execute("DETACH DATABASE source", []).ok();

    // Phase 2: Git worktree and filesystem copy (best-effort).
    // DB records are already committed — failures here are logged but non-fatal.
    for meta in &imported_workspaces {
        if let Err(e) = setup_workspace_filesystem(
            &meta.workspace_id,
            &meta.repo_name,
            &meta.directory_name,
            &meta.state,
            meta.branch.as_deref(),
            meta.repo_root.as_deref(),
            conductor_root.as_deref(),
            &helmor_data_dir,
        ) {
            errors.push(format!("{}: {e}", meta.workspace_id));
        }
    }

    Ok(ImportWorkspacesResult {
        success: errors.is_empty(),
        imported_count,
        skipped_count,
        errors,
    })
}

/// Check if the Conductor database is available for import.
pub fn conductor_source_available() -> bool {
    crate::data_dir::conductor_source_db_path().is_some()
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Metadata collected during Phase 1 (DB import) for Phase 2 (filesystem).
struct ImportedWorkspaceMeta {
    workspace_id: String,
    repo_name: String,
    directory_name: String,
    state: String,
    branch: Option<String>,
    repo_root: Option<PathBuf>,
}

enum ImportDbResult {
    Imported(ImportedWorkspaceMeta),
    Skipped,
}

/// Phase 1: Import database records for a single workspace.
/// No git or filesystem operations — those happen in Phase 2.
fn import_workspace_db_records(conn: &Connection, workspace_id: &str) -> Result<ImportDbResult> {
    // Already imported? Check DB existence AND filesystem completeness.
    // If DB record exists but the worktree directory is missing, allow
    // Phase 2 to re-run by returning Imported (not Skipped).
    let existing: Option<(String, String, String, Option<String>)> = conn
        .query_row(
            "SELECT repository_id, directory_name, state, branch FROM main.workspaces WHERE id = ?1",
            [workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok();

    if let Some((repo_id, directory_name, state, branch)) = existing {
        // DB records exist — check if filesystem setup is complete
        let fs_complete = if state == "archived" {
            true // archived workspaces don't need a worktree
        } else {
            crate::data_dir::workspace_dir(
                &conn
                    .query_row(
                        "SELECT name FROM main.repos WHERE id = ?1",
                        [&repo_id],
                        |r| r.get::<_, String>(0),
                    )
                    .unwrap_or_default(),
                &directory_name,
            )
            .map(|p| p.exists())
            .unwrap_or(false)
        };

        if fs_complete {
            return Ok(ImportDbResult::Skipped);
        }

        // DB exists but filesystem incomplete — return metadata so Phase 2 retries
        let (repo_name, root_path): (String, Option<String>) = conn
            .query_row(
                "SELECT name, root_path FROM main.repos WHERE id = ?1",
                [&repo_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or_else(|_| ("unknown".to_string(), None));

        eprintln!("[import] Workspace {workspace_id} exists in DB but filesystem incomplete — retrying Phase 2");
        return Ok(ImportDbResult::Imported(ImportedWorkspaceMeta {
            workspace_id: workspace_id.to_string(),
            repo_name,
            directory_name,
            state,
            branch,
            repo_root: helpers::non_empty(&root_path).map(PathBuf::from),
        }));
    }

    // Read workspace info from source
    let (repo_id, directory_name, state, branch): (String, String, String, Option<String>) = conn
        .query_row(
            "SELECT repository_id, directory_name, state, branch FROM source.workspaces WHERE id = ?1",
            [workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .with_context(|| format!("Workspace {workspace_id} not found in Conductor"))?;

    // Read repo name + root_path from source
    let (repo_name, root_path): (String, Option<String>) = conn
        .query_row(
            "SELECT name, root_path FROM source.repos WHERE id = ?1",
            [&repo_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .with_context(|| format!("Repo {repo_id} not found in Conductor"))?;

    // 1. Ensure parent repo exists
    let (repo_main, repo_src) = import_column_lists(conn, "repos")?;
    conn.execute(
        &format!(
            "INSERT OR IGNORE INTO main.repos ({repo_main}) SELECT {repo_src} FROM source.repos WHERE id = ?1"
        ),
        [&repo_id],
    )
    .context("Failed to import repo")?;

    // 2. Insert workspace
    let (ws_main, ws_src) = import_column_lists(conn, "workspaces")?;
    conn.execute(
        &format!(
            "INSERT OR IGNORE INTO main.workspaces ({ws_main}) SELECT {ws_src} FROM source.workspaces WHERE id = ?1"
        ),
        [workspace_id],
    )
    .context("Failed to import workspace")?;

    // 3. Insert sessions (handles claude_session_id → provider_session_id rename)
    let (sess_main, sess_src) = import_column_lists(conn, "sessions")?;
    conn.execute(
        &format!(
            "INSERT OR IGNORE INTO main.sessions ({sess_main}) SELECT {sess_src} FROM source.sessions WHERE workspace_id = ?1"
        ),
        [workspace_id],
    )
    .context("Failed to import sessions")?;

    // 4. Insert session_messages
    let (msg_main, msg_src) = import_column_lists(conn, "session_messages")?;
    conn.execute(
        &format!(
            "INSERT OR IGNORE INTO main.session_messages ({msg_main}) \
             SELECT {msg_src} FROM source.session_messages \
             WHERE session_id IN (SELECT id FROM source.sessions WHERE workspace_id = ?1)"
        ),
        [workspace_id],
    )
    .context("Failed to import messages")?;

    // 5. Insert attachments
    let (att_main, att_src) = import_column_lists(conn, "attachments")?;
    conn.execute(
        &format!(
            "INSERT OR IGNORE INTO main.attachments ({att_main}) \
             SELECT {att_src} FROM source.attachments \
             WHERE session_id IN (SELECT id FROM source.sessions WHERE workspace_id = ?1)"
        ),
        [workspace_id],
    )
    .context("Failed to import attachments")?;

    // 6. Insert diff_comments
    let (dc_main, dc_src) = import_column_lists(conn, "diff_comments")?;
    conn.execute(
        &format!(
            "INSERT OR IGNORE INTO main.diff_comments ({dc_main}) \
             SELECT {dc_src} FROM source.diff_comments WHERE workspace_id = ?1"
        ),
        [workspace_id],
    )
    .context("Failed to import diff_comments")?;

    Ok(ImportDbResult::Imported(ImportedWorkspaceMeta {
        workspace_id: workspace_id.to_string(),
        repo_name,
        directory_name,
        state,
        branch,
        repo_root: helpers::non_empty(&root_path).map(PathBuf::from),
    }))
}

/// Phase 2: Set up filesystem for an imported workspace (git worktree + context files).
/// Best-effort — failures are reported but don't affect the committed DB records.
#[allow(clippy::too_many_arguments)]
fn setup_workspace_filesystem(
    workspace_id: &str,
    repo_name: &str,
    directory_name: &str,
    state: &str,
    branch: Option<&str>,
    repo_root: Option<&Path>,
    conductor_root: Option<&Path>,
    helmor_data_dir: &Path,
) -> Result<()> {
    if state != "archived" {
        // Active workspace: create git worktree, then copy .context/
        let workspace_dir = crate::data_dir::workspace_dir(repo_name, directory_name)?;

        if !workspace_dir.exists() {
            if let (Some(branch_name), Some(root)) = (branch, repo_root) {
                if root.is_dir() {
                    let source_branch = resolve_source_branch(
                        root,
                        branch_name,
                        conductor_root,
                        repo_name,
                        directory_name,
                    );

                    if source_branch.is_none() {
                        eprintln!("[import] Could not resolve source branch for {directory_name} — worktree not created");
                    }
                    if let Some(ref src) = source_branch {
                        let import_branch = format!("{src}-import");
                        if let Err(e) =
                            setup_imported_worktree(root, &workspace_dir, &import_branch, src)
                        {
                            eprintln!("[import] Worktree failed for {directory_name}: {e}");
                            // Non-fatal: we still copy .context/ below
                        } else {
                            // Update branch in DB (best-effort, DB is already committed)
                            match crate::models::db::open_connection(true) {
                                Ok(conn) => {
                                    if let Err(e) = conn.execute(
                                        "UPDATE workspaces SET branch = ?1 WHERE id = ?2",
                                        rusqlite::params![import_branch, workspace_id],
                                    ) {
                                        eprintln!("[import] Failed to update branch for {directory_name}: {e}");
                                    }
                                }
                                Err(e) => {
                                    eprintln!("[import] Failed to open DB to update branch for {directory_name}: {e}");
                                }
                            }
                        }
                    }
                }
            }
        }

        // Copy .context/ (whether or not worktree succeeded)
        if let Some(root) = conductor_root {
            let context_src = root
                .join("workspaces")
                .join(repo_name)
                .join(directory_name)
                .join(".context");
            let context_dst = workspace_dir.join(".context");

            if context_src.is_dir() {
                // Overwrite if exists — ensures clean state on re-import
                if context_dst.exists() {
                    std::fs::remove_dir_all(&context_dst).ok();
                }
                std::fs::create_dir_all(context_dst.parent().unwrap_or(&workspace_dir)).ok();
                helpers::copy_dir_all(&context_src, &context_dst).with_context(|| {
                    format!("Failed to copy .context from {}", context_src.display())
                })?;
            }
        }
    } else {
        // Archived workspace: copy archived-contexts/
        if let Some(root) = conductor_root {
            let archive_src = root
                .join("archived-contexts")
                .join(repo_name)
                .join(directory_name);
            let archive_dst = helmor_data_dir
                .join("archived-contexts")
                .join(repo_name)
                .join(directory_name);

            if archive_src.is_dir() {
                // Overwrite if exists — ensures clean state on re-import
                if archive_dst.exists() {
                    std::fs::remove_dir_all(&archive_dst).ok();
                }
                std::fs::create_dir_all(archive_dst.parent().unwrap_or(helmor_data_dir)).ok();
                helpers::copy_dir_all(&archive_src, &archive_dst).with_context(|| {
                    format!(
                        "Failed to copy archived context from {}",
                        archive_src.display()
                    )
                })?;
            }
        }
    }

    // Rewrite attachment paths
    if let Some(root) = conductor_root {
        let conn = crate::models::db::open_connection(true)?;
        rewrite_attachment_paths(
            &conn,
            workspace_id,
            root,
            helmor_data_dir,
            repo_name,
            directory_name,
            state,
        )?;
    }

    // Copy Claude Code session files from Conductor's project dir to Helmor's.
    // Claude Code stores sessions under ~/.claude/projects/{encoded-cwd}/ and
    // the cwd changed from Conductor's worktree to Helmor's worktree, so
    // sessions are invisible unless we copy them over.
    if let Some(root) = conductor_root {
        copy_claude_sessions_for_workspace(root, helmor_data_dir, repo_name, directory_name);
    }

    Ok(())
}

/// Encode a filesystem path into a Claude Code project directory name.
/// Claude uses `path.replace('/', '-').replace('.', '-')`.
fn encode_claude_project_dir(path: &Path) -> String {
    path.display().to_string().replace(['/', '.'], "-")
}

/// Copy Claude Code session .jsonl files from the Conductor project dir
/// to the Helmor project dir so that imported sessions can be resumed.
fn copy_claude_sessions_for_workspace(
    conductor_root: &Path,
    helmor_data_dir: &Path,
    repo_name: &str,
    directory_name: &str,
) {
    let home = match std::env::var_os("HOME").map(PathBuf::from) {
        Some(h) => h,
        None => return,
    };
    let claude_projects = home.join(".claude").join("projects");
    if !claude_projects.is_dir() {
        return;
    }

    let conductor_ws_path = conductor_root
        .join("workspaces")
        .join(repo_name)
        .join(directory_name);
    let helmor_ws_path = helmor_data_dir
        .join("workspaces")
        .join(repo_name)
        .join(directory_name);

    let src_dir = claude_projects.join(encode_claude_project_dir(&conductor_ws_path));
    let dst_dir = claude_projects.join(encode_claude_project_dir(&helmor_ws_path));

    if !src_dir.is_dir() {
        return;
    }

    // Create destination dir if needed
    if std::fs::create_dir_all(&dst_dir).is_err() {
        eprintln!(
            "[import] Failed to create Claude project dir: {}",
            dst_dir.display()
        );
        return;
    }

    // Copy each .jsonl session file (overwrite if exists)
    let entries = match std::fs::read_dir(&src_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let mut copied = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "jsonl") {
            let dst_file = dst_dir.join(entry.file_name());
            if std::fs::copy(&path, &dst_file).is_ok() {
                copied += 1;
            }
        }
    }

    if copied > 0 {
        eprintln!(
            "[import] Copied {copied} Claude session file(s): {} → {}",
            src_dir.display(),
            dst_dir.display()
        );
    }
}

/// Resolve which branch to use as the source for the imported worktree.
///
/// The live Conductor worktree HEAD is the ground truth — the DB branch
/// can lag behind (Conductor can switch branches without updating the DB).
/// We prefer the live worktree branch, falling back to the DB branch.
fn resolve_source_branch(
    repo_root: &Path,
    db_branch: &str,
    conductor_root: Option<&Path>,
    repo_name: &str,
    directory_name: &str,
) -> Option<String> {
    // Prefer the live Conductor worktree HEAD — it's the ground truth
    if let Some(root) = conductor_root {
        let conductor_ws = root.join("workspaces").join(repo_name).join(directory_name);

        if conductor_ws.is_dir() {
            if let Ok(output) = std::process::Command::new("git")
                .args([
                    "-C",
                    &conductor_ws.display().to_string(),
                    "rev-parse",
                    "--abbrev-ref",
                    "HEAD",
                ])
                .output()
            {
                let actual = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !actual.is_empty()
                    && actual != "HEAD"
                    && git_ops::verify_branch_exists(repo_root, &actual).is_ok()
                {
                    if actual != db_branch {
                        eprintln!(
                            "[import] Branch mismatch for {directory_name}: DB has '{db_branch}', \
                             actual is '{actual}' — using actual"
                        );
                    }
                    return Some(actual);
                }
            }
        }
    }

    // Fall back to the DB branch if the live worktree is unavailable
    if git_ops::verify_branch_exists(repo_root, db_branch).is_ok() {
        return Some(db_branch.to_string());
    }

    eprintln!("[import] No valid branch found for {directory_name} (tried '{db_branch}')");
    None
}

/// Create a git worktree for an imported active workspace.
///
/// Creates `new_branch` (e.g. `foo-import`) based on the commit that
/// `source_branch` points to.  The source branch itself is likely still
/// checked out in a Conductor worktree, so we create a new branch.
fn setup_imported_worktree(
    repo_root: &Path,
    workspace_dir: &Path,
    new_branch: &str,
    source_branch: &str,
) -> Result<()> {
    if let Some(parent) = workspace_dir.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create {}", parent.display()))?;
    }

    // Create new branch based on the source branch (a local ref)
    let start_ref = format!("refs/heads/{source_branch}");
    git_ops::create_worktree_from_start_point(repo_root, workspace_dir, new_branch, &start_ref)
        .with_context(|| format!("Failed to create worktree for {new_branch} from {start_ref}"))?;

    Ok(())
}

/// Rewrite attachment paths from Conductor locations to Helmor locations.
fn rewrite_attachment_paths(
    conn: &Connection,
    workspace_id: &str,
    conductor_root: &Path,
    helmor_data_dir: &Path,
    repo_name: &str,
    directory_name: &str,
    state: &str,
) -> Result<()> {
    // Conductor attachment paths may point to:
    //   {root}/workspaces/{repo}/{ws}/.context/attachments/...
    // Even for archived workspaces (paths are not rewritten on archive).
    // We also handle the case where they were rewritten to archived-contexts.

    let conductor_ws_prefix = conductor_root
        .join("workspaces")
        .join(repo_name)
        .join(directory_name)
        .join(".context");
    let conductor_archive_prefix = conductor_root
        .join("archived-contexts")
        .join(repo_name)
        .join(directory_name);

    let helmor_prefix = if state == "archived" {
        helmor_data_dir
            .join("archived-contexts")
            .join(repo_name)
            .join(directory_name)
    } else {
        helmor_data_dir
            .join("workspaces")
            .join(repo_name)
            .join(directory_name)
            .join(".context")
    };

    let helmor_prefix_str = helmor_prefix.to_string_lossy();
    let conductor_ws_str = conductor_ws_prefix.to_string_lossy();
    let conductor_archive_str = conductor_archive_prefix.to_string_lossy();

    // Rewrite active-workspace paths
    conn.execute(
        r#"
        UPDATE main.attachments
        SET path = REPLACE(path, ?1, ?2)
        WHERE session_id IN (
            SELECT id FROM main.sessions WHERE workspace_id = ?3
        ) AND path LIKE ?4
        "#,
        rusqlite::params![
            conductor_ws_str.as_ref(),
            helmor_prefix_str.as_ref(),
            workspace_id,
            format!("{}%", conductor_ws_str),
        ],
    )
    .context("Failed to rewrite workspace attachment paths")?;

    // Rewrite archived-context paths
    conn.execute(
        r#"
        UPDATE main.attachments
        SET path = REPLACE(path, ?1, ?2)
        WHERE session_id IN (
            SELECT id FROM main.sessions WHERE workspace_id = ?3
        ) AND path LIKE ?4
        "#,
        rusqlite::params![
            conductor_archive_str.as_ref(),
            helmor_prefix_str.as_ref(),
            workspace_id,
            format!("{}%", conductor_archive_str),
        ],
    )
    .context("Failed to rewrite archived attachment paths")?;

    Ok(())
}

/// Open the Helmor DB and attach Conductor DB as `source`.
fn open_with_conductor_attached() -> Result<(Connection, String)> {
    let source_path =
        crate::data_dir::conductor_source_db_path().context("Conductor database not found")?;
    let source_display = source_path.display().to_string();
    let dest_path = crate::data_dir::db_path()?;

    let conn = Connection::open_with_flags(
        &dest_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("Failed to open Helmor database")?;

    conn.busy_timeout(std::time::Duration::from_secs(5))
        .context("Failed to set busy timeout")?;

    conn.execute(
        "ATTACH DATABASE ?1 AS source",
        [source_path.to_string_lossy().as_ref()],
    )
    .context("Failed to attach Conductor database")?;

    Ok((conn, source_display))
}

/// Get column names for a table (from the main schema).
fn get_table_columns(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .with_context(|| format!("Failed to get columns for {table}"))?;

    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .context("Failed to query column info")?
        .filter_map(Result::ok)
        .collect();

    if columns.is_empty() {
        bail!("Table {table} has no columns");
    }

    Ok(columns)
}

/// Column name mappings from Conductor (source) → Helmor (main).
/// Used during import to bridge schema renames.
const COLUMN_RENAMES: &[(&str, &str)] = &[("claude_session_id", "provider_session_id")];

/// Build INSERT-SELECT column lists that handle renamed columns between
/// source (Conductor) and main (Helmor) schemas.
///
/// Returns `(main_col_list, source_col_list)` where renamed columns use
/// `source_name AS main_name` in the SELECT list.
fn import_column_lists(conn: &Connection, table: &str) -> Result<(String, String)> {
    let main_cols = get_table_columns(conn, table)?;

    let source_cols: Vec<String> = conn
        .prepare(&format!("PRAGMA source.table_info({table})"))
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>(1))
                .map(|rows| rows.filter_map(Result::ok).collect())
        })
        .unwrap_or_default();

    let source_set: std::collections::HashSet<&str> =
        source_cols.iter().map(|s| s.as_str()).collect();

    // Build column lists using only columns that exist in both schemas
    let mut main_parts = Vec::new();
    let mut source_parts = Vec::new();

    for col in &main_cols {
        if source_set.contains(col.as_str()) {
            // Column exists in both with the same name
            main_parts.push(col.clone());
            source_parts.push(col.clone());
        } else {
            // Check if it was renamed
            let old_name = COLUMN_RENAMES
                .iter()
                .find(|(_, new)| *new == col.as_str())
                .map(|(old, _)| *old);

            if let Some(old) = old_name {
                if source_set.contains(old) {
                    main_parts.push(col.clone());
                    source_parts.push(format!("{old} AS {col}"));
                }
            }
            // Column only in main (new column) — skip, will get DEFAULT value
        }
    }

    if main_parts.is_empty() {
        bail!("No compatible columns found for table {table}");
    }

    Ok((main_parts.join(", "), source_parts.join(", ")))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_db() -> (Connection, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let conn = Connection::open(&db_path).unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        (conn, dir)
    }

    #[test]
    fn import_workspace_db_records_inserts_cascade() {
        let (conn, _dir) = setup_test_db();

        // Create a "source" schema in the same in-memory DB for testing
        conn.execute_batch(
            r#"
            ATTACH DATABASE ':memory:' AS source;
            CREATE TABLE source.repos AS SELECT * FROM main.repos WHERE 0;
            CREATE TABLE source.workspaces AS SELECT * FROM main.workspaces WHERE 0;
            CREATE TABLE source.sessions AS SELECT * FROM main.sessions WHERE 0;
            CREATE TABLE source.session_messages AS SELECT * FROM main.session_messages WHERE 0;
            CREATE TABLE source.attachments AS SELECT * FROM main.attachments WHERE 0;
            CREATE TABLE source.diff_comments AS SELECT * FROM main.diff_comments WHERE 0;

            INSERT INTO source.repos (id, name, created_at, updated_at) VALUES ('r1', 'my-repo', datetime('now'), datetime('now'));
            INSERT INTO source.workspaces (id, repository_id, directory_name, state, created_at, updated_at) VALUES ('w1', 'r1', 'boston', 'ready', datetime('now'), datetime('now'));
            INSERT INTO source.sessions (id, workspace_id, created_at, updated_at) VALUES ('s1', 'w1', datetime('now'), datetime('now'));
            INSERT INTO source.sessions (id, workspace_id, created_at, updated_at) VALUES ('s2', 'w1', datetime('now'), datetime('now'));
            INSERT INTO source.session_messages (id, session_id, role, content, created_at) VALUES ('m1', 's1', 'user', 'hello', datetime('now'));
            INSERT INTO source.session_messages (id, session_id, role, content, created_at) VALUES ('m2', 's2', 'user', 'world', datetime('now'));
            INSERT INTO source.attachments (id, session_id, type, path, created_at) VALUES ('a1', 's1', 'image', '/old/path/img.png', datetime('now'));
            INSERT INTO source.diff_comments (id, workspace_id, body, created_at) VALUES ('dc1', 'w1', 'comment', 1000);
            "#,
        )
        .unwrap();

        let result = import_workspace_db_records(&conn, "w1");
        assert!(matches!(result.unwrap(), ImportDbResult::Imported(_)));

        // Verify cascade
        let repo_count: i64 = conn
            .query_row("SELECT count(*) FROM main.repos", [], |r| r.get(0))
            .unwrap();
        let ws_count: i64 = conn
            .query_row("SELECT count(*) FROM main.workspaces", [], |r| r.get(0))
            .unwrap();
        let sess_count: i64 = conn
            .query_row("SELECT count(*) FROM main.sessions", [], |r| r.get(0))
            .unwrap();
        let msg_count: i64 = conn
            .query_row("SELECT count(*) FROM main.session_messages", [], |r| {
                r.get(0)
            })
            .unwrap();
        let att_count: i64 = conn
            .query_row("SELECT count(*) FROM main.attachments", [], |r| r.get(0))
            .unwrap();
        let dc_count: i64 = conn
            .query_row("SELECT count(*) FROM main.diff_comments", [], |r| r.get(0))
            .unwrap();

        assert_eq!(repo_count, 1);
        assert_eq!(ws_count, 1);
        assert_eq!(sess_count, 2);
        assert_eq!(msg_count, 2);
        assert_eq!(att_count, 1);
        assert_eq!(dc_count, 1);
    }

    #[test]
    fn import_workspace_db_records_skips_existing() {
        let (conn, _dir) = setup_test_db();

        conn.execute_batch(
            r#"
            INSERT INTO main.repos (id, name) VALUES ('r1', 'my-repo');
            INSERT INTO main.workspaces (id, repository_id, directory_name) VALUES ('w1', 'r1', 'boston');

            ATTACH DATABASE ':memory:' AS source;
            CREATE TABLE source.repos AS SELECT * FROM main.repos WHERE 0;
            CREATE TABLE source.workspaces AS SELECT * FROM main.workspaces WHERE 0;
            CREATE TABLE source.sessions AS SELECT * FROM main.sessions WHERE 0;
            CREATE TABLE source.session_messages AS SELECT * FROM main.session_messages WHERE 0;
            CREATE TABLE source.attachments AS SELECT * FROM main.attachments WHERE 0;
            CREATE TABLE source.diff_comments AS SELECT * FROM main.diff_comments WHERE 0;

            INSERT INTO source.repos (id, name, created_at, updated_at) VALUES ('r1', 'my-repo', datetime('now'), datetime('now'));
            INSERT INTO source.workspaces (id, repository_id, directory_name, state, created_at, updated_at) VALUES ('w1', 'r1', 'boston', 'ready', datetime('now'), datetime('now'));
            INSERT INTO source.sessions (id, workspace_id, created_at, updated_at) VALUES ('s1', 'w1', datetime('now'), datetime('now'));
            "#,
        )
        .unwrap();

        let result = import_workspace_db_records(&conn, "w1").unwrap();

        // Workspace exists in DB but worktree directory is missing,
        // so it returns Imported to allow Phase 2 retry
        assert!(
            matches!(
                result,
                ImportDbResult::Imported(_) | ImportDbResult::Skipped
            ),
            "Should return Imported (retry) or Skipped"
        );

        // No new sessions should have been inserted (DB records already exist)
        let sess_count: i64 = conn
            .query_row("SELECT count(*) FROM main.sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sess_count, 0);
    }

    #[test]
    fn get_table_columns_works() {
        let (conn, _dir) = setup_test_db();
        let cols = get_table_columns(&conn, "repos").unwrap();
        assert!(cols.contains(&"id".to_string()));
        assert!(cols.contains(&"name".to_string()));
    }

    #[test]
    fn import_column_lists_handles_renamed_columns() {
        let (conn, _dir) = setup_test_db();

        // Simulate Conductor source with old column name
        conn.execute_batch(
            r#"
            ATTACH DATABASE ':memory:' AS source;
            CREATE TABLE source.sessions (
                id TEXT PRIMARY KEY,
                workspace_id TEXT,
                status TEXT DEFAULT 'idle',
                claude_session_id TEXT,
                model TEXT,
                permission_mode TEXT DEFAULT 'default',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );
            "#,
        )
        .unwrap();

        let (main_cols, src_cols) = import_column_lists(&conn, "sessions").unwrap();

        // main should have provider_session_id, source should map claude_session_id AS provider_session_id
        assert!(
            main_cols.contains("provider_session_id"),
            "main_cols should contain provider_session_id: {main_cols}"
        );
        assert!(
            src_cols.contains("claude_session_id AS provider_session_id"),
            "src_cols should map old→new: {src_cols}"
        );
    }

    #[test]
    fn import_column_lists_handles_identical_schemas() {
        let (conn, _dir) = setup_test_db();

        conn.execute_batch(
            r#"
            ATTACH DATABASE ':memory:' AS source;
            CREATE TABLE source.repos AS SELECT * FROM main.repos WHERE 0;
            "#,
        )
        .unwrap();

        let (main_cols, src_cols) = import_column_lists(&conn, "repos").unwrap();
        // When schemas are identical, both column lists should be the same
        assert_eq!(main_cols, src_cols);
    }

    #[test]
    fn import_column_lists_drops_source_only_columns() {
        let (conn, _dir) = setup_test_db();

        // Source has an extra column that main doesn't
        conn.execute_batch(
            r#"
            ATTACH DATABASE ':memory:' AS source;
            CREATE TABLE source.repos (
                id TEXT PRIMARY KEY,
                name TEXT,
                extra_conductor_field TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );
            "#,
        )
        .unwrap();

        let (main_cols, src_cols) = import_column_lists(&conn, "repos").unwrap();
        // extra_conductor_field should NOT appear in either list
        assert!(
            !main_cols.contains("extra_conductor_field"),
            "main_cols should not contain source-only column"
        );
        assert!(
            !src_cols.contains("extra_conductor_field"),
            "src_cols should not contain source-only column"
        );
    }

    #[test]
    fn import_preserves_conductor_provider_session_id() {
        let (conn, _dir) = setup_test_db();

        conn.execute_batch(
            r#"
            ATTACH DATABASE ':memory:' AS source;
            CREATE TABLE source.repos AS SELECT * FROM main.repos WHERE 0;
            CREATE TABLE source.workspaces AS SELECT * FROM main.workspaces WHERE 0;
            CREATE TABLE source.sessions (
                id TEXT PRIMARY KEY,
                workspace_id TEXT,
                status TEXT DEFAULT 'idle',
                claude_session_id TEXT,
                model TEXT,
                permission_mode TEXT DEFAULT 'default',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE source.session_messages AS SELECT * FROM main.session_messages WHERE 0;
            CREATE TABLE source.attachments AS SELECT * FROM main.attachments WHERE 0;
            CREATE TABLE source.diff_comments AS SELECT * FROM main.diff_comments WHERE 0;

            INSERT INTO source.repos (id, name, created_at, updated_at) VALUES ('r1', 'my-repo', datetime('now'), datetime('now'));
            INSERT INTO source.workspaces (id, repository_id, directory_name, state, created_at, updated_at) VALUES ('w1', 'r1', 'boston', 'ready', datetime('now'), datetime('now'));
            INSERT INTO source.sessions (id, workspace_id, claude_session_id, created_at, updated_at)
                VALUES ('s1', 'w1', 'real-claude-uuid-123', datetime('now'), datetime('now'));
            "#,
        )
        .unwrap();

        let result = import_workspace_db_records(&conn, "w1");
        assert!(matches!(result.unwrap(), ImportDbResult::Imported(_)));

        // Verify the old claude_session_id was imported as provider_session_id
        let provider_sid: Option<String> = conn
            .query_row(
                "SELECT provider_session_id FROM main.sessions WHERE id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            provider_sid.as_deref(),
            Some("real-claude-uuid-123"),
            "claude_session_id should be mapped to provider_session_id"
        );
    }

    #[test]
    fn encode_claude_project_dir_encodes_correctly() {
        let path = PathBuf::from("/Users/me/.conductor/workspaces/repo/ws");
        let encoded = encode_claude_project_dir(&path);
        assert_eq!(encoded, "-Users-me--conductor-workspaces-repo-ws");

        let path2 = PathBuf::from("/Users/me/.helmor.dev/workspaces/repo/ws");
        let encoded2 = encode_claude_project_dir(&path2);
        assert_eq!(encoded2, "-Users-me--helmor-dev-workspaces-repo-ws");
    }
}
