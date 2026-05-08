# Global Repo Preferences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add app-level "global" preferences that act as a per-field template for repo preferences, with per-field inherit/override flags, an auto-detach-on-edit + reset-to-global UX, migration B (empty fields auto-follow on existing repos), and a propagation toast on global save.

**Architecture:** Add 6 BOOLEAN `inherit_global_*` columns on `repos`. Store global preferences as a JSON blob under `settings.global_repo_preferences`. Backend resolves an `effective` `RepoPreferences` per repo: `inherit ? global : override`. Frontend gets the resolved struct plus the raw `overrides`, `inherit`, and `global`, so the UI can render badges, placeholders, and the reset link.

**Tech Stack:** Rust + rusqlite (Tauri backend), serde, Tauri IPC, React 19 + TanStack Query + shadcn/ui (Tailwind v4), Vitest, cargo test + insta.

**Reference spec:** `docs/superpowers/specs/2026-05-08-global-preferences-design.md`.

---

## Task 1: Schema migration — add 6 inherit columns + backfill

**Files:**
- Modify: `src-tauri/src/schema.rs` (around line 564, after the `workspaces.mode` migration block; also update the canonical `SCHEMA_SQL` for fresh installs at line 570)
- Test: `src-tauri/src/schema.rs` (`#[cfg(test)] mod tests` at the bottom — add a new test there. If the file has no test module yet, create one.)

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/schema.rs`:

```rust
#[cfg(test)]
mod inherit_global_tests {
    use rusqlite::Connection;

    fn legacy_repos_table(conn: &Connection) {
        conn.execute_batch(
            r#"
            CREATE TABLE repos (
                id TEXT PRIMARY KEY,
                name TEXT,
                custom_prompt_create_pr TEXT,
                custom_prompt_review TEXT,
                custom_prompt_fix_errors TEXT,
                custom_prompt_resolve_merge_conflicts TEXT,
                custom_prompt_rename_branch TEXT,
                custom_prompt_general TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO repos (id, name, custom_prompt_review, custom_prompt_general)
              VALUES ('a', 'a', NULL,                NULL);
            INSERT INTO repos (id, name, custom_prompt_review, custom_prompt_general)
              VALUES ('b', 'b', '',                  'has general');
            INSERT INTO repos (id, name, custom_prompt_review, custom_prompt_general)
              VALUES ('c', 'c', 'has review',        '');
            INSERT INTO repos (id, name, custom_prompt_review, custom_prompt_general)
              VALUES ('d', 'd', 'has review',        'has general');
            "#,
        )
        .unwrap();
    }

    #[test]
    fn migration_adds_columns_and_backfills_inherit_flags() {
        let conn = Connection::open_in_memory().unwrap();
        legacy_repos_table(&conn);

        super::ensure_schema(&conn).unwrap();

        let inherit = |id: &str, col: &str| -> i64 {
            conn.query_row(
                &format!("SELECT {col} FROM repos WHERE id = ?1"),
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };

        // Empty / NULL → inherit = 1 (rule B).
        assert_eq!(inherit("a", "inherit_global_review"), 1);
        assert_eq!(inherit("a", "inherit_global_general"), 1);
        assert_eq!(inherit("b", "inherit_global_review"), 1);   // empty ''
        assert_eq!(inherit("c", "inherit_global_general"), 1);  // empty ''

        // Non-empty → inherit = 0 (preserve override).
        assert_eq!(inherit("b", "inherit_global_general"), 0);
        assert_eq!(inherit("c", "inherit_global_review"), 0);
        assert_eq!(inherit("d", "inherit_global_review"), 0);
        assert_eq!(inherit("d", "inherit_global_general"), 0);
    }

    #[test]
    fn migration_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        legacy_repos_table(&conn);
        super::ensure_schema(&conn).unwrap();
        super::ensure_schema(&conn).unwrap();
        // Did not panic; columns still single-instance.
        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('repos')")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let count = cols
            .iter()
            .filter(|c| c.as_str() == "inherit_global_review")
            .count();
        assert_eq!(count, 1);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test schema::inherit_global_tests -- --nocapture`
Expected: FAIL — columns `inherit_global_*` do not exist.

- [ ] **Step 3: Add the migration block**

In `src-tauri/src/schema.rs`, immediately *before* the closing `Ok(())` of `ensure_schema` (after the `workspaces.mode` block ending around line 564), insert:

```rust
    // Migration: per-field "inherit global" flags for repo preferences.
    // When set, the corresponding custom_prompt_* column is ignored at
    // resolution time and the value comes from the global template
    // stored under settings key `global_repo_preferences`. Rule B
    // backfill: existing rows inherit any field whose override is NULL
    // or empty; non-empty overrides stay detached.
    const INHERIT_FIELDS: &[(&str, &str)] = &[
        ("inherit_global_create_pr", "custom_prompt_create_pr"),
        ("inherit_global_review", "custom_prompt_review"),
        ("inherit_global_fix_errors", "custom_prompt_fix_errors"),
        (
            "inherit_global_resolve_conflicts",
            "custom_prompt_resolve_merge_conflicts",
        ),
        ("inherit_global_rename_branch", "custom_prompt_rename_branch"),
        ("inherit_global_general", "custom_prompt_general"),
    ];
    if has_table(connection, "repos") {
        for (flag_col, override_col) in INHERIT_FIELDS {
            assert_safe_identifier(flag_col);
            assert_safe_identifier(override_col);
            if !has_column(connection, "repos", flag_col) {
                connection
                    .execute_batch(&format!(
                        "ALTER TABLE repos ADD COLUMN {flag_col} INTEGER NOT NULL DEFAULT 0"
                    ))
                    .with_context(|| format!("Failed to add repos.{flag_col} column"))?;
                connection
                    .execute_batch(&format!(
                        "UPDATE repos SET {flag_col} = 1 \
                         WHERE {override_col} IS NULL OR {override_col} = ''"
                    ))
                    .with_context(|| {
                        format!("Failed to backfill repos.{flag_col} from {override_col}")
                    })?;
            }
        }
    }
```

Then in the `SCHEMA_SQL` constant (line 570), add the six columns to the canonical `repos` table definition, immediately after `custom_prompt_resolve_merge_conflicts TEXT,` (so a fresh install creates them). Append:

```sql
    inherit_global_create_pr INTEGER NOT NULL DEFAULT 0,
    inherit_global_review INTEGER NOT NULL DEFAULT 0,
    inherit_global_fix_errors INTEGER NOT NULL DEFAULT 0,
    inherit_global_resolve_conflicts INTEGER NOT NULL DEFAULT 0,
    inherit_global_rename_branch INTEGER NOT NULL DEFAULT 0,
    inherit_global_general INTEGER NOT NULL DEFAULT 0,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test schema::inherit_global_tests -- --nocapture`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/schema.rs
git commit -m "feat(schema): add inherit_global_* columns with rule-B backfill"
```

---

## Task 2: Backend types — `InheritFlags` + `RepoPreferencesResolved` + global accessors

**Files:**
- Modify: `src-tauri/src/models/repos.rs` (extend the `RepoPreferences` block at line 640; add new types and helpers)
- Modify: `src-tauri/src/models/settings.rs` (add typed accessors for the global blob)

- [ ] **Step 1: Write the failing tests** (in a new `#[cfg(test)] mod global_prefs_tests` at the bottom of `src-tauri/src/models/repos.rs`)

```rust
#[cfg(test)]
mod global_prefs_tests {
    use super::*;
    use crate::models::db;
    use crate::models::settings::{load_global_repo_preferences, save_global_repo_preferences};

    fn setup() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        // SAFETY: single-threaded test process. HELMOR_DATA_DIR is read at
        // first connection; we set it before any db::*_conn() call.
        unsafe {
            std::env::set_var("HELMOR_DATA_DIR", dir.path());
        }
        db::reset_for_tests();
        let conn = db::write_conn().unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        dir
    }

    fn insert_repo(id: &str) {
        let conn = db::write_conn().unwrap();
        conn.execute(
            "INSERT INTO repos (id, name, root_path) VALUES (?1, ?2, ?3)",
            rusqlite::params![id, id, "/tmp"],
        )
        .unwrap();
    }

    #[test]
    fn inherit_all_uses_global() {
        let _g = setup();
        insert_repo("r1");
        save_global_repo_preferences(&RepoPreferences {
            review: Some("global review".into()),
            ..Default::default()
        })
        .unwrap();
        // Default new-repo state: all flags = 0, but flip review to inherit.
        update_repo_preferences(
            "r1",
            &RepoPreferences::default(),
            &InheritFlags {
                review: true,
                ..Default::default()
            },
        )
        .unwrap();

        let resolved = load_repo_preferences("r1").unwrap();
        assert_eq!(resolved.effective.review.as_deref(), Some("global review"));
        assert_eq!(resolved.inherit.review, true);
        assert!(resolved.overrides.review.is_none());
        assert_eq!(resolved.global.review.as_deref(), Some("global review"));
    }

    #[test]
    fn override_wins_when_inherit_false() {
        let _g = setup();
        insert_repo("r2");
        save_global_repo_preferences(&RepoPreferences {
            review: Some("global review".into()),
            ..Default::default()
        })
        .unwrap();
        update_repo_preferences(
            "r2",
            &RepoPreferences {
                review: Some("override".into()),
                ..Default::default()
            },
            &InheritFlags::default(),
        )
        .unwrap();

        let resolved = load_repo_preferences("r2").unwrap();
        assert_eq!(resolved.effective.review.as_deref(), Some("override"));
        assert_eq!(resolved.inherit.review, false);
    }

    #[test]
    fn override_text_preserved_when_toggling_inherit_back() {
        let _g = setup();
        insert_repo("r3");
        // 1. user types an override
        update_repo_preferences(
            "r3",
            &RepoPreferences {
                review: Some("kept text".into()),
                ..Default::default()
            },
            &InheritFlags::default(),
        )
        .unwrap();
        // 2. user clicks "Reset to global" (inherit = true, override unchanged)
        update_repo_preferences(
            "r3",
            &RepoPreferences {
                review: Some("kept text".into()),
                ..Default::default()
            },
            &InheritFlags {
                review: true,
                ..Default::default()
            },
        )
        .unwrap();
        let resolved = load_repo_preferences("r3").unwrap();
        assert_eq!(resolved.overrides.review.as_deref(), Some("kept text"));
        assert_eq!(resolved.effective.review, None); // global is empty
    }
}
```

> **Note:** if `db::reset_for_tests()` does not exist, replace with whatever the project's test pattern is (the existing tests in `settings.rs` open an ad-hoc connection and call `ensure_schema`; if so, mirror that approach and bypass `db::*_conn` by passing a `&Connection` directly — adjust `update_repo_preferences` / `load_repo_preferences` to take an explicit connection variant or expose `*_with_conn` helpers used by the tests). Keep test scope small: real production callers will use the no-arg form.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test global_prefs_tests`
Expected: FAIL — `InheritFlags`, `load_global_repo_preferences`, etc. do not exist.

- [ ] **Step 3: Add the new settings accessors**

In `src-tauri/src/models/settings.rs`, after the auto-close functions (around line 158), append:

```rust
const GLOBAL_REPO_PREFERENCES_KEY: &str = "global_repo_preferences";

pub fn load_global_repo_preferences() -> Result<crate::models::repos::RepoPreferences> {
    Ok(load_setting_json::<crate::models::repos::RepoPreferences>(GLOBAL_REPO_PREFERENCES_KEY)?
        .unwrap_or_default())
}

pub fn save_global_repo_preferences(
    preferences: &crate::models::repos::RepoPreferences,
) -> Result<()> {
    upsert_setting_json(GLOBAL_REPO_PREFERENCES_KEY, preferences)
}
```

- [ ] **Step 4: Add the new backend types**

In `src-tauri/src/models/repos.rs`, replace the existing `RepoPreferences` struct (lines 640-649) with:

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPreferences {
    pub create_pr: Option<String>,
    pub review: Option<String>,
    pub fix_errors: Option<String>,
    pub resolve_conflicts: Option<String>,
    pub branch_rename: Option<String>,
    pub general: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InheritFlags {
    pub create_pr: bool,
    pub review: bool,
    pub fix_errors: bool,
    pub resolve_conflicts: bool,
    pub branch_rename: bool,
    pub general: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPreferencesResolved {
    /// Raw `custom_prompt_*` values (preserved across inherit toggles).
    pub overrides: RepoPreferences,
    pub inherit: InheritFlags,
    /// Snapshot of the app-level template at read time.
    pub global: RepoPreferences,
    /// `inherit ? global : override` per field — what the agent sees.
    pub effective: RepoPreferences,
}

impl RepoPreferences {
    fn pick(global: &RepoPreferences, override_: &RepoPreferences, inherit: &InheritFlags) -> Self {
        Self {
            create_pr: if inherit.create_pr { global.create_pr.clone() } else { override_.create_pr.clone() },
            review:    if inherit.review    { global.review.clone() }    else { override_.review.clone() },
            fix_errors: if inherit.fix_errors { global.fix_errors.clone() } else { override_.fix_errors.clone() },
            resolve_conflicts: if inherit.resolve_conflicts { global.resolve_conflicts.clone() } else { override_.resolve_conflicts.clone() },
            branch_rename: if inherit.branch_rename { global.branch_rename.clone() } else { override_.branch_rename.clone() },
            general: if inherit.general { global.general.clone() } else { override_.general.clone() },
        }
    }
}
```

- [ ] **Step 5: Replace `load_repo_preferences` and `update_repo_preferences`**

Replace the existing functions (lines 843-908) with:

```rust
pub fn load_repo_preferences(repo_id: &str) -> Result<RepoPreferencesResolved> {
    let connection = db::read_conn()?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT
              custom_prompt_create_pr,
              custom_prompt_review,
              custom_prompt_fix_errors,
              custom_prompt_resolve_merge_conflicts,
              custom_prompt_rename_branch,
              custom_prompt_general,
              inherit_global_create_pr,
              inherit_global_review,
              inherit_global_fix_errors,
              inherit_global_resolve_conflicts,
              inherit_global_rename_branch,
              inherit_global_general
            FROM repos
            WHERE id = ?1
            "#,
        )
        .with_context(|| format!("Failed to prepare preferences lookup for {repo_id}"))?;

    let (overrides, inherit) = statement
        .query_row([repo_id], |row| {
            let overrides = RepoPreferences {
                create_pr: row.get(0)?,
                review: row.get(1)?,
                fix_errors: row.get(2)?,
                resolve_conflicts: row.get(3)?,
                branch_rename: row.get(4)?,
                general: row.get(5)?,
            };
            let inherit = InheritFlags {
                create_pr: row.get::<_, i64>(6)? != 0,
                review: row.get::<_, i64>(7)? != 0,
                fix_errors: row.get::<_, i64>(8)? != 0,
                resolve_conflicts: row.get::<_, i64>(9)? != 0,
                branch_rename: row.get::<_, i64>(10)? != 0,
                general: row.get::<_, i64>(11)? != 0,
            };
            Ok((overrides, inherit))
        })
        .with_context(|| format!("Repository not found: {repo_id}"))?;

    let global = crate::models::settings::load_global_repo_preferences()?;
    let effective = RepoPreferences::pick(&global, &overrides, &inherit);

    Ok(RepoPreferencesResolved {
        overrides,
        inherit,
        global,
        effective,
    })
}

pub fn update_repo_preferences(
    repo_id: &str,
    overrides: &RepoPreferences,
    inherit: &InheritFlags,
) -> Result<()> {
    let connection = db::write_conn()?;
    let updated = connection
        .execute(
            r#"
            UPDATE repos
            SET
              custom_prompt_create_pr = ?1,
              custom_prompt_review = ?2,
              custom_prompt_fix_errors = ?3,
              custom_prompt_resolve_merge_conflicts = ?4,
              custom_prompt_rename_branch = ?5,
              custom_prompt_general = ?6,
              inherit_global_create_pr = ?7,
              inherit_global_review = ?8,
              inherit_global_fix_errors = ?9,
              inherit_global_resolve_conflicts = ?10,
              inherit_global_rename_branch = ?11,
              inherit_global_general = ?12,
              updated_at = datetime('now')
            WHERE id = ?13
            "#,
            rusqlite::params![
                normalize_repo_preference(overrides.create_pr.as_deref()),
                normalize_repo_preference(overrides.review.as_deref()),
                normalize_repo_preference(overrides.fix_errors.as_deref()),
                normalize_repo_preference(overrides.resolve_conflicts.as_deref()),
                normalize_repo_preference(overrides.branch_rename.as_deref()),
                normalize_repo_preference(overrides.general.as_deref()),
                inherit.create_pr as i64,
                inherit.review as i64,
                inherit.fix_errors as i64,
                inherit.resolve_conflicts as i64,
                inherit.branch_rename as i64,
                inherit.general as i64,
                repo_id
            ],
        )
        .with_context(|| format!("Failed to update preferences for {repo_id}"))?;

    if updated != 1 {
        bail!("Repository not found: {repo_id}");
    }

    Ok(())
}

/// Returns the number of repositories that inherit at least one of the
/// fields whose value differs between `previous` and `next`. Used to
/// drive the "X repositories follow these changes" toast.
pub fn count_repos_following_changed_global_fields(
    previous: &RepoPreferences,
    next: &RepoPreferences,
) -> Result<u32> {
    let changed = changed_field_flag_columns(previous, next);
    if changed.is_empty() {
        return Ok(0);
    }
    let connection = db::read_conn()?;
    let where_clause = changed
        .iter()
        .map(|c| format!("{c} = 1"))
        .collect::<Vec<_>>()
        .join(" OR ");
    let sql = format!("SELECT COUNT(DISTINCT id) FROM repos WHERE {where_clause}");
    let count: i64 = connection
        .query_row(&sql, [], |r| r.get(0))
        .context("Failed to count following repos")?;
    Ok(count.max(0) as u32)
}

fn changed_field_flag_columns(a: &RepoPreferences, b: &RepoPreferences) -> Vec<&'static str> {
    let mut out = Vec::new();
    if a.create_pr != b.create_pr { out.push("inherit_global_create_pr"); }
    if a.review != b.review { out.push("inherit_global_review"); }
    if a.fix_errors != b.fix_errors { out.push("inherit_global_fix_errors"); }
    if a.resolve_conflicts != b.resolve_conflicts { out.push("inherit_global_resolve_conflicts"); }
    if a.branch_rename != b.branch_rename { out.push("inherit_global_rename_branch"); }
    if a.general != b.general { out.push("inherit_global_general"); }
    out
}
```

- [ ] **Step 6: Find and update existing callers of `load_repo_preferences`**

Run: `Grep load_repo_preferences --glob '!tests/**'`
Update each caller (currently `agents/queries.rs:139` and any others) to use `.effective` from the returned `RepoPreferencesResolved`. Example:

```rust
// before
let prefs = repos::load_repo_preferences(repo_id)?;
prefs.general.as_deref()
// after
let prefs = repos::load_repo_preferences(repo_id)?.effective;
prefs.general.as_deref()
```

- [ ] **Step 7: Run tests**

Run: `cd src-tauri && cargo test global_prefs_tests`
Expected: PASS.
Run: `cd src-tauri && cargo build --tests`
Expected: clean build (no compile errors from changed callers).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/models/repos.rs src-tauri/src/models/settings.rs src-tauri/src/agents/queries.rs
git commit -m "feat(repos): resolve repo preferences against global template"
```

---

## Task 3: Default new repos to inherit-all

**Files:**
- Modify: `src-tauri/src/models/repos.rs:316-347` (`insert_repository`)
- Test: `src-tauri/src/models/repos.rs` (add to `global_prefs_tests`)

- [ ] **Step 1: Write the failing test** (append to `global_prefs_tests`)

```rust
#[test]
fn newly_inserted_repo_inherits_all_fields() {
    let _g = setup();
    let conn = db::write_conn().unwrap();
    conn.execute(
        "INSERT INTO repos (id, name, root_path) VALUES ('new', 'new', '/tmp')",
        [],
    )
    .unwrap();
    // Simulate the production path's intent: defaults set explicitly.
    set_default_inherit_flags_on_insert("new").unwrap();

    let resolved = load_repo_preferences("new").unwrap();
    assert!(resolved.inherit.create_pr);
    assert!(resolved.inherit.review);
    assert!(resolved.inherit.fix_errors);
    assert!(resolved.inherit.resolve_conflicts);
    assert!(resolved.inherit.branch_rename);
    assert!(resolved.inherit.general);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test global_prefs_tests::newly_inserted_repo_inherits_all_fields`
Expected: FAIL — `set_default_inherit_flags_on_insert` not defined.

- [ ] **Step 3: Add the helper and call it from `insert_repository`**

In `src-tauri/src/models/repos.rs`, add (next to `update_repo_preferences`):

```rust
/// Set all six inherit_global_* flags to 1 for a freshly-inserted repo
/// so it picks up the global template by default.
pub(crate) fn set_default_inherit_flags_on_insert(repo_id: &str) -> Result<()> {
    let connection = db::write_conn()?;
    connection
        .execute(
            r#"
            UPDATE repos SET
              inherit_global_create_pr = 1,
              inherit_global_review = 1,
              inherit_global_fix_errors = 1,
              inherit_global_resolve_conflicts = 1,
              inherit_global_rename_branch = 1,
              inherit_global_general = 1
            WHERE id = ?1
            "#,
            [repo_id],
        )
        .with_context(|| format!("Failed to default inherit flags for {repo_id}"))?;
    Ok(())
}
```

Then in `insert_repository` (line 305), immediately before `Ok(repo_id)` at line 349, add:

```rust
    set_default_inherit_flags_on_insert(&repo_id)?;
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test global_prefs_tests`
Expected: PASS, all four tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/models/repos.rs
git commit -m "feat(repos): new repos inherit global preferences by default"
```

---

## Task 4: IPC commands — register global accessors and update repo prefs signature

**Files:**
- Modify: `src-tauri/src/commands/repository_commands.rs:91-94` and `:124-130`
- Modify: `src-tauri/src/commands/settings_commands.rs` (add two new commands; create the file's existing module pattern)
- Modify: `src-tauri/src/lib.rs:340-360` (registration list)

- [ ] **Step 1: Update `load_repo_preferences` and `update_repo_preferences` commands**

In `src-tauri/src/commands/repository_commands.rs`, replace lines 91-94 with:

```rust
#[tauri::command]
pub async fn load_repo_preferences(
    repo_id: String,
) -> CmdResult<repos::RepoPreferencesResolved> {
    run_blocking(move || repos::load_repo_preferences(&repo_id)).await
}
```

And replace lines 124-130 with:

```rust
#[tauri::command]
pub async fn update_repo_preferences(
    repo_id: String,
    overrides: repos::RepoPreferences,
    inherit: repos::InheritFlags,
) -> CmdResult<()> {
    run_blocking(move || repos::update_repo_preferences(&repo_id, &overrides, &inherit)).await
}
```

- [ ] **Step 2: Add the two new global commands**

Open `src-tauri/src/commands/settings_commands.rs`. Find the `#[tauri::command]` declarations near the top of the file (the existing `get_app_settings`/`update_app_settings` patterns referenced in the spec). Append:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalPreferencesUpdateSummary {
    /// Number of repos that inherit at least one of the fields that
    /// changed in this save.
    pub repos_affected: u32,
}

#[tauri::command]
pub async fn load_global_preferences() -> CmdResult<crate::models::repos::RepoPreferences> {
    run_blocking(crate::models::settings::load_global_repo_preferences).await
}

#[tauri::command]
pub async fn update_global_preferences(
    preferences: crate::models::repos::RepoPreferences,
) -> CmdResult<GlobalPreferencesUpdateSummary> {
    run_blocking(move || -> anyhow::Result<GlobalPreferencesUpdateSummary> {
        let previous = crate::models::settings::load_global_repo_preferences()?;
        crate::models::settings::save_global_repo_preferences(&preferences)?;
        let repos_affected = crate::models::repos::count_repos_following_changed_global_fields(
            &previous, &preferences,
        )?;
        Ok(GlobalPreferencesUpdateSummary { repos_affected })
    })
    .await
}
```

If `Serialize` and `run_blocking` aren't imported at the top of the file, add:

```rust
use serde::Serialize;
use crate::commands::run_blocking;
use crate::error::CmdResult;
```

(Match whatever import style the existing commands in this file use.)

- [ ] **Step 3: Register the new commands in `lib.rs`**

In `src-tauri/src/lib.rs`, locate the `tauri::generate_handler![...]` list (around line 340-360, where `load_repo_preferences` and `update_repo_preferences` are listed). Add to the list:

```rust
            commands::settings_commands::load_global_preferences,
            commands::settings_commands::update_global_preferences,
```

- [ ] **Step 4: Verify build**

Run: `bun run typecheck` (Rust will be re-checked indirectly) and `cd src-tauri && cargo build`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/repository_commands.rs src-tauri/src/commands/settings_commands.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): expose global preferences load/update commands"
```

---

## Task 5: Pipeline scenario test for resolution

**Files:**
- Modify or extend: `src-tauri/tests/pipeline_scenarios.rs` (or a new dedicated file `src-tauri/tests/repo_preferences.rs`)

The pipeline accumulator does not depend on `RepoPreferences`, so a snapshot test in `pipeline_scenarios.rs` is the wrong target. Use a focused integration test instead.

- [ ] **Step 1: Create the test file**

Create `src-tauri/tests/repo_preferences.rs`:

```rust
mod common;

use helmor_lib::models::repos::{
    load_repo_preferences, update_repo_preferences, InheritFlags, RepoPreferences,
};
use helmor_lib::models::settings::save_global_repo_preferences;

#[test]
fn mixed_inherit_and_override_resolves_per_field() {
    let _ctx = common::isolated_data_dir();
    common::insert_repo("repo-1");

    save_global_repo_preferences(&RepoPreferences {
        create_pr: Some("global cpr".into()),
        review: Some("global review".into()),
        general: Some("global general".into()),
        ..Default::default()
    })
    .unwrap();

    update_repo_preferences(
        "repo-1",
        &RepoPreferences {
            review: Some("repo review".into()),
            ..Default::default()
        },
        &InheritFlags {
            create_pr: true,  // inherit
            review: false,    // override
            general: true,    // inherit
            ..Default::default()
        },
    )
    .unwrap();

    let resolved = load_repo_preferences("repo-1").unwrap();
    assert_eq!(resolved.effective.create_pr.as_deref(), Some("global cpr"));
    assert_eq!(resolved.effective.review.as_deref(), Some("repo review"));
    assert_eq!(resolved.effective.general.as_deref(), Some("global general"));
    // Fields neither global nor override has remain None.
    assert!(resolved.effective.fix_errors.is_none());
}
```

> If `tests/common/mod.rs` doesn't already expose `isolated_data_dir()` and `insert_repo()`, add them. They should: (a) create a tempdir, set `HELMOR_DATA_DIR`, run schema, and return a guard; (b) insert a minimal `repos` row by id. Mirror the helper style used in existing tests under `src-tauri/tests/common/`.

- [ ] **Step 2: Run the test**

Run: `cd src-tauri && cargo test --test repo_preferences`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tests/repo_preferences.rs src-tauri/tests/common/mod.rs
git commit -m "test: integration coverage for repo preferences resolution"
```

---

## Task 6: Frontend API wrappers

**Files:**
- Modify: `src/lib/api.ts:2848-2931` (extend the preferences section)

- [ ] **Step 1: Update types**

Replace the `RepoPreferences` block at line 2848 with:

```typescript
export type RepoPreferences = {
	createPr?: string | null;
	review?: string | null;
	fixErrors?: string | null;
	resolveConflicts?: string | null;
	branchRename?: string | null;
	general?: string | null;
};

export type InheritFlags = {
	createPr: boolean;
	review: boolean;
	fixErrors: boolean;
	resolveConflicts: boolean;
	branchRename: boolean;
	general: boolean;
};

export type RepoPreferencesResolved = {
	overrides: RepoPreferences;
	inherit: InheritFlags;
	global: RepoPreferences;
	effective: RepoPreferences;
};

export type GlobalPreferencesUpdateSummary = {
	reposAffected: number;
};

export const EMPTY_INHERIT_FLAGS: InheritFlags = {
	createPr: false,
	review: false,
	fixErrors: false,
	resolveConflicts: false,
	branchRename: false,
	general: false,
};
```

- [ ] **Step 2: Update `loadRepoPreferences` / `updateRepoPreferences` and add global wrappers**

Replace lines 2915-2931 with:

```typescript
export async function loadRepoPreferences(
	repoId: string,
): Promise<RepoPreferencesResolved> {
	return invoke<RepoPreferencesResolved>("load_repo_preferences", {
		repoId,
	});
}

export async function updateRepoPreferences(
	repoId: string,
	overrides: RepoPreferences,
	inherit: InheritFlags,
): Promise<void> {
	await invoke("update_repo_preferences", {
		repoId,
		overrides,
		inherit,
	});
}

export async function loadGlobalPreferences(): Promise<RepoPreferences> {
	return invoke<RepoPreferences>("load_global_preferences");
}

export async function updateGlobalPreferences(
	preferences: RepoPreferences,
): Promise<GlobalPreferencesUpdateSummary> {
	return invoke<GlobalPreferencesUpdateSummary>("update_global_preferences", {
		preferences,
	});
}
```

- [ ] **Step 3: Add a query key for global prefs**

In `src/lib/query-client.ts`, in the `helmorQueryKeys` object, add an entry next to `repoPreferences`:

```typescript
globalPreferences: () => ["global-preferences"] as const,
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck`
Expected: PASS, but the existing `RepositoryPreferencesSection` will now have type errors on `preferencesQuery.data` shape and `updateRepoPreferences` arity. We fix those in Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/query-client.ts
git commit -m "feat(api): typed wrappers for global preferences"
```

> Note: typecheck will be RED after this commit because Task 7 has not landed yet. That's intentional — the steps are tightly coupled and split only for review granularity. Run `bun run typecheck` again after Task 7.

---

## Task 7: Repo preferences UI — badge, auto-detach, reset link, placeholder

**Files:**
- Modify: `src/features/settings/panels/repository-preferences-section.tsx` (full rewrite of the component body)
- Test: `src/features/settings/panels/repository-preferences-section.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `src/features/settings/panels/repository-preferences-section.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RepositoryPreferencesSection } from "./repository-preferences-section";

vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		...actual,
		loadRepoPreferences: vi.fn(),
		updateRepoPreferences: vi.fn().mockResolvedValue(undefined),
	};
});

import { loadRepoPreferences, updateRepoPreferences } from "@/lib/api";

const baseResolved = {
	overrides: { review: null },
	inherit: {
		createPr: true,
		review: true,
		fixErrors: true,
		resolveConflicts: true,
		branchRename: true,
		general: true,
	},
	global: { review: "Global review prompt" },
	effective: { review: "Global review prompt" },
};

function renderSection() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<RepositoryPreferencesSection repoId="r1" />
		</QueryClientProvider>,
	);
}

describe("RepositoryPreferencesSection", () => {
	beforeEach(() => {
		vi.mocked(loadRepoPreferences).mockResolvedValue(baseResolved as never);
		vi.mocked(updateRepoPreferences).mockClear();
	});

	it("renders 'Following global' badge when inherit is true", async () => {
		renderSection();
		fireEvent.click(await screen.findByText(/Review/i));
		expect(await screen.findAllByText(/Following global/i)).not.toHaveLength(0);
	});

	it("auto-detaches inherit when user types into the textarea", async () => {
		renderSection();
		fireEvent.click(await screen.findByText(/Review/i));
		const textarea = await screen.findByPlaceholderText(/Global review prompt/i);
		fireEvent.change(textarea, { target: { value: "my override" } });
		fireEvent.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() => {
			expect(updateRepoPreferences).toHaveBeenCalled();
		});
		const [, overrides, inherit] = vi.mocked(updateRepoPreferences).mock.calls[0];
		expect(overrides.review).toBe("my override");
		expect(inherit.review).toBe(false);
	});

	it("reset-to-global re-attaches and clears the editable value", async () => {
		vi.mocked(loadRepoPreferences).mockResolvedValueOnce({
			...baseResolved,
			inherit: { ...baseResolved.inherit, review: false },
			overrides: { review: "old override" },
			effective: { review: "old override" },
		} as never);

		renderSection();
		fireEvent.click(await screen.findByText(/Review/i));
		fireEvent.click(await screen.findByRole("button", { name: /Reset to global/i }));
		fireEvent.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() => {
			expect(updateRepoPreferences).toHaveBeenCalled();
		});
		const [, , inherit] = vi.mocked(updateRepoPreferences).mock.calls[0];
		expect(inherit.review).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest run src/features/settings/panels/repository-preferences-section.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Rewrite the component**

Replace the contents of `src/features/settings/panels/repository-preferences-section.tsx` with:

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Eye } from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { LazyStreamdown } from "@/components/streamdown-loader";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
	EMPTY_INHERIT_FLAGS,
	type InheritFlags,
	loadRepoPreferences,
	type RepoPreferences,
	type RepoPreferencesResolved,
	updateRepoPreferences,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	REPO_PREFERENCE_DESCRIPTIONS,
	REPO_PREFERENCE_LABELS,
	type RepoPreferenceKey,
	resolveRepoPreferencePreview,
} from "@/lib/repo-preferences-prompts";

const PREFERENCE_KEYS: RepoPreferenceKey[] = [
	"createPr",
	"review",
	"fixErrors",
	"resolveConflicts",
	"branchRename",
	"general",
];

const EMPTY_RESOLVED: RepoPreferencesResolved = {
	overrides: {},
	inherit: { ...EMPTY_INHERIT_FLAGS },
	global: {},
	effective: {},
};

function placeholderFor(key: RepoPreferenceKey, globalText: string | null | undefined): string {
	if (globalText && globalText.trim()) {
		const truncated = globalText.length > 140 ? `${globalText.slice(0, 140)}…` : globalText;
		return `Following global: ${truncated}`;
	}
	if (key === "general") {
		return "Add custom instructions for all agents working in this repo.";
	}
	return "Add your preferences here. The agent will be told to prioritize these instructions over its default instructions.";
}

export function RepositoryPreferencesSection({ repoId }: { repoId: string }) {
	const queryClient = useQueryClient();
	const preferencesQuery = useQuery({
		queryKey: helmorQueryKeys.repoPreferences(repoId),
		queryFn: () => loadRepoPreferences(repoId),
		staleTime: 0,
	});
	const resolved: RepoPreferencesResolved = preferencesQuery.data ?? EMPTY_RESOLVED;

	const [draftOverrides, setDraftOverrides] = useState<RepoPreferences>({});
	const [draftInherit, setDraftInherit] = useState<InheritFlags>(EMPTY_INHERIT_FLAGS);
	const [openKey, setOpenKey] = useState<RepoPreferenceKey | null>(null);
	const [savingKey, setSavingKey] = useState<RepoPreferenceKey | null>(null);
	const [previewKey, setPreviewKey] = useState<RepoPreferenceKey | null>(null);

	useEffect(() => {
		setDraftOverrides(resolved.overrides);
		setDraftInherit(resolved.inherit);
	}, [resolved]);

	const previewMarkdown = useMemo(() => {
		if (!previewKey) return "";
		// Preview the value the agent would actually see.
		const previewSource: RepoPreferences = { ...draftOverrides };
		for (const k of PREFERENCE_KEYS) {
			if (draftInherit[k]) {
				previewSource[k] = resolved.global[k] ?? null;
			}
		}
		return resolveRepoPreferencePreview(previewKey, previewSource);
	}, [draftOverrides, draftInherit, resolved.global, previewKey]);

	return (
		<>
			<div className="py-5">
				<div className="text-[13px] font-medium leading-snug text-foreground">
					Preferences
				</div>
				<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
					Repo-level prompts. Each field can follow the global template or be overridden per repo.
				</div>
				<div className="mt-4 divide-y divide-app-border/20">
					{PREFERENCE_KEYS.map((key) => {
						const isOpen = openKey === key;
						const isInherit = draftInherit[key];
						const editorValue = isInherit
							? ""
							: (draftOverrides[key] ?? "");
						const placeholder = placeholderFor(key, resolved.global[key]);
						return (
							<Collapsible
								key={key}
								open={isOpen}
								onOpenChange={(next) => setOpenKey(next ? key : null)}
							>
								<div className="py-4">
									<CollapsibleTrigger asChild>
										<button
											type="button"
											className="flex w-full cursor-pointer items-start justify-between gap-4 text-left"
										>
											<div className="flex-1">
												<div className="flex items-center gap-2">
													<div className="text-[13px] font-medium text-app-foreground">
														{REPO_PREFERENCE_LABELS[key]}
													</div>
													<span
														className={
															isInherit
																? "rounded-full bg-app-base/40 px-2 py-[2px] text-[10px] font-medium uppercase tracking-wide text-app-muted"
																: "rounded-full bg-accent/15 px-2 py-[2px] text-[10px] font-medium uppercase tracking-wide text-accent-foreground"
														}
													>
														{isInherit ? "Following global" : "Overridden"}
													</span>
												</div>
												<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
													{REPO_PREFERENCE_DESCRIPTIONS[key]}
												</div>
											</div>
											<ChevronDown
												className={`mt-0.5 size-4 shrink-0 text-app-muted transition-transform ${
													isOpen ? "rotate-180" : ""
												}`}
												strokeWidth={1.8}
											/>
										</button>
									</CollapsibleTrigger>
									<CollapsibleContent className="pt-4">
										<Textarea
											className="min-h-[140px] resize-y bg-app-base/30 font-mono text-[12px] placeholder:text-[12px]"
											placeholder={placeholder}
											value={editorValue}
											onChange={(event) => {
												const next = event.target.value;
												setDraftOverrides((current) => ({
													...current,
													[key]: next,
												}));
												// Auto-detach on edit.
												setDraftInherit((current) => ({
													...current,
													[key]: false,
												}));
											}}
										/>
										<div className="mt-3 flex items-center justify-between gap-3">
											<div className="flex items-center gap-3">
												<button
													type="button"
													className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-app-muted transition-colors hover:text-app-foreground"
													onClick={() => setPreviewKey(key)}
												>
													<Eye className="size-3.5" strokeWidth={1.8} />
													<span>Preview</span>
												</button>
												{!isInherit && (
													<button
														type="button"
														className="cursor-pointer text-[12px] text-app-muted underline-offset-4 hover:text-app-foreground hover:underline"
														onClick={() =>
															setDraftInherit((current) => ({
																...current,
																[key]: true,
															}))
														}
													>
														Reset to global
													</button>
												)}
											</div>
											<Button
												size="sm"
												disabled={savingKey === key}
												onClick={() => {
													setSavingKey(key);
													void updateRepoPreferences(
														repoId,
														draftOverrides,
														draftInherit,
													)
														.then(async () => {
															await queryClient.invalidateQueries({
																queryKey:
																	helmorQueryKeys.repoPreferences(repoId),
															});
														})
														.finally(() => setSavingKey(null));
												}}
											>
												{savingKey === key ? "Saving..." : "Save"}
											</Button>
										</div>
									</CollapsibleContent>
								</div>
							</Collapsible>
						);
					})}
				</div>
			</div>

			<Dialog
				open={previewKey !== null}
				onOpenChange={(open) => !open && setPreviewKey(null)}
			>
				<DialogContent className="w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] sm:w-[min(76vw,760px)] sm:max-w-[760px] rounded-2xl border-border/60 bg-background p-0 shadow-2xl">
					<div className="px-6 pt-4">
						<DialogTitle className="text-[18px] font-semibold text-foreground">
							{previewKey
								? `${REPO_PREFERENCE_LABELS[previewKey]} prompt`
								: "Prompt preview"}
						</DialogTitle>
					</div>
					<div className="max-h-[78vh] overflow-y-auto px-6 pb-5 pt-1">
						<div className="conversation-markdown max-w-none break-words text-[13px] leading-6 text-foreground">
							<Suspense
								fallback={
									<pre className="whitespace-pre-wrap break-words">
										{previewMarkdown}
									</pre>
								}
							>
								<LazyStreamdown
									className="conversation-streamdown"
									mode="static"
								>
									{previewMarkdown}
								</LazyStreamdown>
							</Suspense>
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
```

- [ ] **Step 4: Run tests**

Run: `bun x vitest run src/features/settings/panels/repository-preferences-section.test.tsx`
Expected: PASS, all three tests.
Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/panels/repository-preferences-section.tsx src/features/settings/panels/repository-preferences-section.test.tsx
git commit -m "feat(settings): inherit/override UX in repo preferences"
```

---

## Task 8: Global preferences UI section

**Files:**
- Create: `src/features/settings/panels/global-preferences.tsx`
- Test: `src/features/settings/panels/global-preferences.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/features/settings/panels/global-preferences.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Toaster } from "sonner";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { GlobalPreferencesPanel } from "./global-preferences";

vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		...actual,
		loadGlobalPreferences: vi.fn().mockResolvedValue({}),
		updateGlobalPreferences: vi.fn(),
	};
});

import { loadGlobalPreferences, updateGlobalPreferences } from "@/lib/api";

function renderPanel() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Toaster />
			<GlobalPreferencesPanel />
		</QueryClientProvider>,
	);
}

describe("GlobalPreferencesPanel", () => {
	beforeEach(() => {
		vi.mocked(loadGlobalPreferences).mockResolvedValue({});
		vi.mocked(updateGlobalPreferences).mockReset();
	});

	it("toasts the affected count after save (non-zero)", async () => {
		vi.mocked(updateGlobalPreferences).mockResolvedValue({ reposAffected: 5 });
		renderPanel();
		fireEvent.click(await screen.findByText(/Review/i));
		const textarea = await screen.findByRole("textbox");
		fireEvent.change(textarea, { target: { value: "new global review" } });
		fireEvent.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() => {
			expect(screen.getByText(/5 repositories/i)).toBeInTheDocument();
		});
	});

	it("suppresses toast when zero repos are affected", async () => {
		vi.mocked(updateGlobalPreferences).mockResolvedValue({ reposAffected: 0 });
		renderPanel();
		fireEvent.click(await screen.findByText(/Review/i));
		const textarea = await screen.findByRole("textbox");
		fireEvent.change(textarea, { target: { value: "x" } });
		fireEvent.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() => {
			expect(updateGlobalPreferences).toHaveBeenCalled();
		});
		expect(screen.queryByText(/repositories/i)).not.toBeInTheDocument();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun x vitest run src/features/settings/panels/global-preferences.test.tsx`
Expected: FAIL — `GlobalPreferencesPanel` not exported.

- [ ] **Step 3: Implement the panel**

Create `src/features/settings/panels/global-preferences.tsx`:

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import {
	loadGlobalPreferences,
	type RepoPreferences,
	updateGlobalPreferences,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	REPO_PREFERENCE_DESCRIPTIONS,
	REPO_PREFERENCE_LABELS,
	type RepoPreferenceKey,
} from "@/lib/repo-preferences-prompts";

const PREFERENCE_KEYS: RepoPreferenceKey[] = [
	"createPr",
	"review",
	"fixErrors",
	"resolveConflicts",
	"branchRename",
	"general",
];

export function GlobalPreferencesPanel() {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: helmorQueryKeys.globalPreferences(),
		queryFn: loadGlobalPreferences,
		staleTime: 0,
	});
	const preferences: RepoPreferences = query.data ?? {};
	const [drafts, setDrafts] = useState<RepoPreferences>({});
	const [openKey, setOpenKey] = useState<RepoPreferenceKey | null>(null);
	const [savingKey, setSavingKey] = useState<RepoPreferenceKey | null>(null);

	useEffect(() => {
		setDrafts(preferences);
	}, [preferences]);

	return (
		<div className="py-5">
			<div className="text-[13px] font-medium leading-snug text-foreground">
				Global preferences
			</div>
			<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
				Template prompts inherited by every repo. Edits propagate to repos that follow each field.
			</div>
			<div className="mt-4 divide-y divide-app-border/20">
				{PREFERENCE_KEYS.map((key) => {
					const isOpen = openKey === key;
					const value = drafts[key] ?? "";
					return (
						<Collapsible
							key={key}
							open={isOpen}
							onOpenChange={(next) => setOpenKey(next ? key : null)}
						>
							<div className="py-4">
								<CollapsibleTrigger asChild>
									<button
										type="button"
										className="flex w-full cursor-pointer items-start justify-between gap-4 text-left"
									>
										<div>
											<div className="text-[13px] font-medium text-app-foreground">
												{REPO_PREFERENCE_LABELS[key]}
											</div>
											<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
												{REPO_PREFERENCE_DESCRIPTIONS[key]}
											</div>
										</div>
										<ChevronDown
											className={`mt-0.5 size-4 shrink-0 text-app-muted transition-transform ${
												isOpen ? "rotate-180" : ""
											}`}
											strokeWidth={1.8}
										/>
									</button>
								</CollapsibleTrigger>
								<CollapsibleContent className="pt-4">
									<Textarea
										className="min-h-[140px] resize-y bg-app-base/30 font-mono text-[12px] placeholder:text-[12px]"
										placeholder="Default prompt used by every repo unless overridden."
										value={value}
										onChange={(event) =>
											setDrafts((current) => ({
												...current,
												[key]: event.target.value,
											}))
										}
									/>
									<div className="mt-3 flex justify-end">
										<Button
											size="sm"
											disabled={savingKey === key}
											onClick={() => {
												setSavingKey(key);
												void updateGlobalPreferences({
													...preferences,
													[key]: value,
												})
													.then(async (summary) => {
														await queryClient.invalidateQueries({
															queryKey: helmorQueryKeys.globalPreferences(),
														});
														await queryClient.invalidateQueries({
															// Any open repo preferences view should re-resolve.
															predicate: (q) =>
																Array.isArray(q.queryKey) &&
																q.queryKey[0] === "repo-preferences",
														});
														if (summary.reposAffected > 0) {
															toast(
																`Updated global preferences · ${summary.reposAffected} repositor${
																	summary.reposAffected === 1 ? "y follows" : "ies follow"
																} these changes`,
															);
														}
													})
													.finally(() => setSavingKey(null));
											}}
										>
											{savingKey === key ? "Saving..." : "Save"}
										</Button>
									</div>
								</CollapsibleContent>
							</div>
						</Collapsible>
					);
				})}
			</div>
		</div>
	);
}
```

- [ ] **Step 4: Run tests**

Run: `bun x vitest run src/features/settings/panels/global-preferences.test.tsx`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/panels/global-preferences.tsx src/features/settings/panels/global-preferences.test.tsx
git commit -m "feat(settings): add global preferences panel with propagation toast"
```

---

## Task 9: Wire the panel into the settings dialog

**Files:**
- Modify: `src/features/settings/index.tsx`

- [ ] **Step 1: Read the current section list**

Read `src/features/settings/index.tsx` lines 110-140 (the `SettingsSection` union and label maps) and the panel-rendering switch (search for the `case "general":` style switch — likely in the dialog body around lines 990-1020).

- [ ] **Step 2: Add the new section variant**

In the `SettingsSection` type union (line 119-129), add `"globalPreferences"`:

```typescript
export type SettingsSection =
	| "general"
	| "globalPreferences"
	// ... rest unchanged
```

In `SECTION_LABEL_OVERRIDES` (line 134), add:

```typescript
	globalPreferences: "Global preferences",
```

- [ ] **Step 3: Render the panel**

Find the section rendering switch in the dialog body (likely a series of `activeSection === "general"` blocks). Add an entry that renders `<GlobalPreferencesPanel />` when `activeSection === "globalPreferences"`. Import it at the top of the file:

```typescript
import { GlobalPreferencesPanel } from "./panels/global-preferences";
```

Add the panel to whichever sidebar list controls navigation (search the file for where the existing sections like `"general"` and `"appearance"` are listed for the sidebar — add `"globalPreferences"` next to a related entry such as `"general"`).

- [ ] **Step 4: Manually verify**

Run: `bun run dev`
Open the settings dialog. Confirm:
- "Global preferences" appears in the sidebar.
- Clicking it shows six collapsible fields.
- Saving a change toasts when at least one repo follows the changed field.
- Opening any repo's preferences shows badges and inherits placeholder from global.

- [ ] **Step 5: Run typecheck and tests**

Run: `bun run typecheck && bun run test:frontend`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/index.tsx
git commit -m "feat(settings): expose global preferences in settings dialog"
```

---

## Task 10: Final verification

- [ ] **Step 1: Full test sweep**

Run: `bun run test`
Expected: All three suites (frontend / sidecar / rust) pass.

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: clean (biome + clippy zero warnings).

- [ ] **Step 3: Changeset**

Create a changeset entry per project convention. Run the existing `helmor-release` workflow (skill `helmor-release`) or write one manually:

```
.changeset/<random-name>.md
---
"helmor": minor
---

Add global preferences as a per-field template for repo preferences. Each repo can follow the global value or override it; editing global propagates to repos that follow that field.
```

- [ ] **Step 4: Commit**

```bash
git add .changeset/
git commit -m "chore(release): changeset for global preferences"
```
