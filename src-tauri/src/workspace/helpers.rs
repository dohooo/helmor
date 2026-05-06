use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{LazyLock, Mutex},
};

use crate::{
    forge::{self, remote::parse_remote, ForgeProvider},
    git_ops,
    models::workspaces::WorkspaceRecord,
    workspace_state::WorkspaceMode,
    workspace_status::WorkspaceStatus,
};

/// Resolve the on-disk path a workspace operates against. Worktree
/// workspaces live under the helmor data dir; Local workspaces operate
/// directly on the source repo's root path.
pub fn workspace_path(record: &WorkspaceRecord) -> Result<PathBuf> {
    match record.mode {
        WorkspaceMode::Worktree => {
            crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)
        }
        WorkspaceMode::Local => non_empty(&record.root_path)
            .map(PathBuf::from)
            .with_context(|| format!("Workspace {} (local) is missing repo root_path", record.id)),
    }
}

// ---- Display / naming helpers ----

pub fn display_title(record: &WorkspaceRecord) -> String {
    if let Some(pr_title) = non_empty(&record.pr_title) {
        return pr_title.to_string();
    }

    // Local workspaces don't own a `directory_name` (they share the
    // user's repo root with potentially other local workspaces). Use
    // the first conversation's title to differentiate them in the
    // sidebar; primary_session_title is the most-message-count
    // non-hidden session, which lines up with "the conversation" in
    // practice. Fall back to "Untitled" / repo name when nothing is
    // populated yet.
    if record.mode == WorkspaceMode::Local {
        if let Some(title) = non_empty(&record.primary_session_title)
            .or_else(|| non_empty(&record.active_session_title))
        {
            if title != "Untitled" {
                return title.to_string();
            }
        }
        return record.repo_name.clone();
    }

    if let Some(session_title) = non_empty(&record.active_session_title) {
        if session_title != "Untitled" {
            return session_title.to_string();
        }
    }

    humanize_directory_name(&record.directory_name)
}

/// Operational local: live HEAD. Worktree or archived local: stored
/// snapshot (worktree is pinned; archived must freeze at archive time).
/// Errors fall back to stored so the UI never blanks.
// TODO(perf): one `git branch --show-current` subprocess per row;
// cache by repo path with watcher invalidation if it shows up in profiles.
pub fn live_branch_label(record: &WorkspaceRecord) -> Option<String> {
    if record.mode != WorkspaceMode::Local || !record.state.is_operational() {
        return record.branch.clone();
    }
    let Ok(workspace_dir) = workspace_path(record) else {
        return record.branch.clone();
    };
    if !workspace_dir.is_dir() {
        return record.branch.clone();
    }
    git_ops::current_branch_name(&workspace_dir)
        .ok()
        .filter(|b| !b.trim().is_empty())
        .or_else(|| record.branch.clone())
}

pub fn humanize_directory_name(directory_name: &str) -> String {
    directory_name
        .split(['-', '_'])
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let mut characters = segment.chars();
            match characters.next() {
                Some(first) if first.is_ascii_alphabetic() => {
                    let mut label = String::new();
                    label.push(first.to_ascii_uppercase());
                    label.push_str(characters.as_str());
                    label
                }
                Some(first) => {
                    let mut label = String::new();
                    label.push(first);
                    label.push_str(characters.as_str());
                    label
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|inner| !inner.trim().is_empty())
}

pub fn next_available_branch_name(repo_root: &Path, base: &str) -> Result<String> {
    if git_ops::verify_branch_exists(repo_root, base).is_err() {
        return Ok(base.to_string());
    }

    for version in 1..=999 {
        let candidate = format!("{base}-v{version}");
        if git_ops::verify_branch_exists(repo_root, &candidate).is_err() {
            return Ok(candidate);
        }
    }

    bail!("No available branch name found for {base} after 999 attempts")
}

// ---- Sidebar sorting helpers ----

pub fn group_id_from_status(status: WorkspaceStatus) -> &'static str {
    status.group_id()
}

pub fn sidebar_sort_rank(record: &WorkspaceRecord) -> usize {
    record.status.sort_rank()
}

// ---- Repo icon helpers ----

const REPO_ICON_CANDIDATES: &[&str] = &[
    "public/apple-touch-icon.png",
    "apple-touch-icon.png",
    "public/favicon.svg",
    "favicon.svg",
    "public/logo.svg",
    "logo.svg",
    "public/favicon.png",
    "public/icon.png",
    "public/logo.png",
    "favicon.png",
    "app/icon.png",
    "src/app/icon.png",
    "public/favicon.ico",
    "favicon.ico",
    "app/favicon.ico",
    "static/favicon.ico",
    "src-tauri/icons/icon.png",
    "assets/icon.png",
    "src/assets/icon.png",
];

static REPO_ICON_SRC_CACHE: LazyLock<Mutex<HashMap<String, Option<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn repo_icon_path_for_root_path(root_path: Option<&str>) -> Option<String> {
    let root_path = root_path?.trim();

    if root_path.is_empty() {
        return None;
    }

    let root = Path::new(root_path);

    for candidate in REPO_ICON_CANDIDATES {
        let path = root.join(candidate);

        if path.is_file() {
            return Some(path.display().to_string());
        }
    }

    None
}

pub fn repo_icon_src_for_root_path(root_path: Option<&str>) -> Option<String> {
    let root_path = root_path?.trim();
    if root_path.is_empty() {
        return None;
    }

    if let Ok(cache) = REPO_ICON_SRC_CACHE.lock() {
        if let Some(cached) = cache.get(root_path) {
            return cached.clone();
        }
    }

    let icon_path = repo_icon_path_for_root_path(Some(root_path));
    let icon_src = icon_path.and_then(|icon_path| {
        let mime_type = repo_icon_mime_type(Path::new(&icon_path));
        let bytes = fs::read(icon_path).ok()?;

        Some(format!(
            "data:{mime_type};base64,{}",
            BASE64_STANDARD.encode(bytes)
        ))
    });

    if let Ok(mut cache) = REPO_ICON_SRC_CACHE.lock() {
        cache.insert(root_path.to_string(), icon_src.clone());
    }

    icon_src
}

pub fn repo_icon_mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        _ => "image/png",
    }
}

pub fn repo_initials_for_name(repo_name: &str) -> String {
    let segments = repo_name
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();

    let mut initials = String::new();

    if segments.len() >= 2 {
        for segment in segments.iter().take(2) {
            if let Some(character) = segment.chars().next() {
                initials.push(character.to_ascii_uppercase());
            }
        }
    }

    if initials.is_empty() {
        for character in repo_name
            .chars()
            .filter(|character| character.is_ascii_alphanumeric())
        {
            initials.push(character.to_ascii_uppercase());

            if initials.len() == 2 {
                break;
            }
        }
    }

    if initials.is_empty() {
        "WS".to_string()
    } else {
        initials
    }
}

// ---- File system helpers ----

pub fn copy_dir_contents(source: &Path, destination: &Path) -> Result<()> {
    if !source.exists() {
        fs::create_dir_all(destination)
            .with_context(|| format!("Failed to create directory {}", destination.display()))?;
        return Ok(());
    }

    if !source.is_dir() {
        bail!("Expected directory at {}", source.display());
    }

    fs::create_dir_all(destination)
        .with_context(|| format!("Failed to create directory {}", destination.display()))?;

    let entries = fs::read_dir(source)
        .with_context(|| format!("Failed to read directory {}", source.display()))?;

    for entry in entries {
        let entry = entry.context("Failed to read directory entry")?;
        let entry_source = entry.path();
        let entry_destination = destination.join(entry.file_name());
        copy_dir_all(&entry_source, &entry_destination)?;
    }

    Ok(())
}

pub fn copy_dir_all(source: &Path, destination: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source)
        .with_context(|| format!("Failed to read {}", source.display()))?;

    if metadata.file_type().is_symlink() {
        return copy_symlink(source, destination);
    }

    if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!(
                    "Failed to create parent directory for {}",
                    destination.display()
                )
            })?;
        }
        fs::copy(source, destination).with_context(|| {
            format!(
                "Failed to copy {} to {}",
                source.display(),
                destination.display()
            )
        })?;
        return Ok(());
    }

    fs::create_dir_all(destination)
        .with_context(|| format!("Failed to create directory {}", destination.display()))?;

    let entries = fs::read_dir(source)
        .with_context(|| format!("Failed to read directory {}", source.display()))?;

    for entry in entries {
        let entry = entry.context("Failed to read directory entry")?;
        let entry_source = entry.path();
        let entry_destination = destination.join(entry.file_name());
        copy_dir_all(&entry_source, &entry_destination)?;
    }

    Ok(())
}

pub fn copy_symlink(source: &Path, destination: &Path) -> Result<()> {
    use std::os::unix::fs::symlink;

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "Failed to create parent directory for symlink {}",
                destination.display()
            )
        })?;
    }

    let link_target = fs::read_link(source)
        .with_context(|| format!("Failed to read symlink {}", source.display()))?;
    symlink(&link_target, destination).with_context(|| {
        format!(
            "Failed to copy symlink {} to {}",
            source.display(),
            destination.display()
        )
    })
}

// ---- Branch / directory name helpers ----

pub const WORKSPACE_NAMES: &[&str] = &[
    "achernar",
    "adrastea",
    "aegaeon",
    "aegir",
    "aitne",
    "albiorix",
    "alcor",
    "alcyoneus",
    "aldebaran",
    "alnilam",
    "alnitak",
    "alpheratz",
    "altair",
    "aludra",
    "amalthea",
    "ananke",
    "andromeda",
    "angrboda",
    "antares",
    "anthe",
    "aoede",
    "aquarius",
    "arche",
    "arcturus",
    "ariel",
    "aries",
    "artemis",
    "atlas",
    "autonoe",
    "barnards",
    "bearpaw",
    "bebhionn",
    "belinda",
    "bellatrix",
    "bergelmir",
    "bestla",
    "betelgeuse",
    "bianca",
    "blackeye",
    "blinking",
    "bodes",
    "butterfly",
    "caliban",
    "callirrhoe",
    "callisto",
    "calypso",
    "cancer",
    "canopus",
    "capella",
    "carme",
    "carpo",
    "cartwheel",
    "cassiopeia",
    "castor",
    "centaurusa",
    "cepheus",
    "chaldene",
    "cigar",
    "circinus",
    "cocoon",
    "comapinwheel",
    "comet",
    "condor",
    "cordelia",
    "cressida",
    "cupid",
    "cygnus",
    "cyllene",
    "daphnis",
    "delphinus",
    "deneb",
    "desdemona",
    "despina",
    "dione",
    "diphda",
    "draco",
    "dubhe",
    "dustyhands",
    "dysnomia",
    "earth",
    "elara",
    "enceladus",
    "epimetheus",
    "erinde",
    "erinome",
    "erriapus",
    "euanthe",
    "eukelade",
    "euporie",
    "europa",
    "eurydome",
    "eyeofgod",
    "eyeofsauron",
    "farbauti",
    "fenrir",
    "ferdinand",
    "fireworks",
    "fomalhaut",
    "fornjot",
    "francisco",
    "friedegg",
    "galatea",
    "ganymede",
    "gemini",
    "gerd",
    "grasshopper",
    "greip",
    "gridr",
    "hadar",
    "halimede",
    "hamal",
    "harpalyke",
    "hati",
    "hegemone",
    "helene",
    "helike",
    "helix",
    "hercules",
    "hermippe",
    "herse",
    "hiiaka",
    "himalia",
    "hippocamp",
    "hoagsobject",
    "hockeystick",
    "hydra",
    "hyperion",
    "hyrrokkin",
    "iapetus",
    "ijiraq",
    "iocaste",
    "isonoe",
    "janus",
    "jarnsaxa",
    "juliet",
    "jupiter",
    "kale",
    "leo",
    "lepus",
    "lyra",
    "mars",
    "menkent",
    "merak",
    "mercury",
    "milkyway",
    "mintaka",
    "mirach",
    "mizar",
    "monoceros",
    "neptune",
    "nunki",
    "orion",
    "pegasus",
    "perseus",
    "phoenix",
    "pinwheel",
    "pisces",
    "pluto",
    "polaris",
    "pollux",
    "procyon",
    "rasalhague",
    "regulus",
    "rhea",
    "rigel",
    "sadr",
    "sagittarius",
    "saturn",
    "scorpius",
    "shaula",
    "sirius",
    "sombrero",
    "spica",
    "taurus",
    "titan",
    "triangulum",
    "triton",
    "uranus",
    "ursamajor",
    "ursaminor",
    "vega",
    "venus",
    "whirlpool",
    "zubenelgenubi",
    "zubeneschamali",
];

pub fn branch_name_for_directory(
    directory_name: &str,
    settings: &crate::settings::EffectiveBranchPrefixSettings,
) -> String {
    use crate::settings::BranchPrefixType;

    // NULL / unrecognised values default to Username — keeps legacy
    // rows that predate the per-repo column behaving the same as the
    // explicit default.
    let prefix_type = settings
        .branch_prefix_type
        .unwrap_or(BranchPrefixType::Username);

    let prefix = match prefix_type {
        BranchPrefixType::Custom => settings
            .branch_prefix_custom
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("")
            .to_string(),
        BranchPrefixType::None => String::new(),
        BranchPrefixType::Username => {
            if let Ok(Some(login)) = resolve_forge_login(settings) {
                format!("{login}/")
            } else {
                String::new()
            }
        }
    };

    format!("{prefix}{directory_name}")
}

/// Whether `branch` is still the auto-generated default derived from the
/// workspace's celestial-body `directory_name`.
pub fn is_default_branch_name(
    branch: &str,
    directory_name: &str,
    settings: &crate::settings::EffectiveBranchPrefixSettings,
) -> bool {
    branch == branch_name_for_directory(directory_name, settings)
}

pub fn is_auto_generated_branch_name(
    branch: &str,
    directory_name: &str,
    settings: &crate::settings::EffectiveBranchPrefixSettings,
) -> bool {
    let base = branch_name_for_directory(directory_name, settings);
    branch == base
        || branch.strip_prefix(&base).is_some_and(|suffix| {
            suffix.strip_prefix("-v").is_some_and(|version| {
                !version.is_empty() && version.chars().all(|c| c.is_ascii_digit())
            })
        })
}

fn resolve_forge_login(
    settings: &crate::settings::EffectiveBranchPrefixSettings,
) -> Result<Option<String>> {
    // Prefer the per-repo binding (set at repo creation by
    // `forge::accounts::auto_bind_repo_account` and updatable via the
    // Connect flow). Fall back to the bundled `glab auth status` for
    // GitLab when the repo predates the binding feature.
    if let Some(login) = settings
        .forge_login
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(Some(login.to_string()));
    }

    let provider = settings
        .forge_provider
        .as_deref()
        .and_then(|value| ForgeProvider::from_str(value).ok())
        .unwrap_or(ForgeProvider::Github);

    match provider {
        ForgeProvider::Gitlab => resolve_gitlab_login(settings),
        ForgeProvider::Unknown if remote_url_looks_like_gitlab(settings) => {
            resolve_gitlab_login(settings)
        }
        ForgeProvider::Github | ForgeProvider::Unknown => Ok(None),
    }
}

fn remote_url_looks_like_gitlab(settings: &crate::settings::EffectiveBranchPrefixSettings) -> bool {
    settings
        .remote_url
        .as_deref()
        .and_then(parse_remote)
        .is_some_and(|remote| remote.host.contains("gitlab"))
}

/// Legacy fallback for repo rows that predate `forge_login`: probe
/// glab directly. Transient `list_logins` failures collapse to
/// `Ok(None)` so the branch-prefix path degrades to "no prefix"
/// rather than bubbling — caller already treats `Err` and `Ok(None)`
/// the same way (`if let Ok(Some(...))`).
fn resolve_gitlab_login(
    settings: &crate::settings::EffectiveBranchPrefixSettings,
) -> Result<Option<String>> {
    let host = settings
        .remote_url
        .as_deref()
        .and_then(parse_remote)
        .map(|remote| remote.host)
        .unwrap_or_else(|| "gitlab.com".to_string());

    let Some(backend) = forge::accounts::backend_for(ForgeProvider::Gitlab) else {
        return Ok(None);
    };
    Ok(backend
        .list_logins(&host)
        .ok()
        .and_then(|logins| logins.into_iter().next()))
}

pub fn allocate_directory_name_for_repo(repo_id: &str) -> Result<String> {
    let connection = crate::db::read_conn()?;
    allocate_directory_name_with_conn(&connection, repo_id)
}

pub fn allocate_directory_name_with_conn(
    connection: &rusqlite::Connection,
    repo_id: &str,
) -> Result<String> {
    use rand::prelude::IndexedRandom;

    let mut statement = connection
        .prepare(
            "SELECT directory_name FROM workspaces WHERE repository_id = ?1 AND directory_name IS NOT NULL",
        )
        .context("Failed to prepare workspace name query")?;

    let names = statement
        .query_map([repo_id], |row| row.get::<_, String>(0))
        .context("Failed to query existing workspace names")?
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("Failed to read existing workspace names")?;

    let used = names
        .into_iter()
        .map(|value| value.to_ascii_lowercase())
        .collect::<std::collections::HashSet<_>>();

    // Collect available names (not yet used) and pick one randomly
    let available: Vec<&&str> = WORKSPACE_NAMES
        .iter()
        .filter(|name| !used.contains(**name))
        .collect();

    if let Some(name) = available.choose(&mut rand::rng()) {
        return Ok((**name).to_string());
    }

    // All names taken — append version suffix and pick randomly
    for version in 2..=999 {
        let versioned: Vec<String> = WORKSPACE_NAMES
            .iter()
            .map(|name| format!("{name}-v{version}"))
            .filter(|candidate| !used.contains(candidate.as_str()))
            .collect();

        if let Some(name) = versioned.choose(&mut rand::rng()) {
            return Ok(name.clone());
        }
    }

    bail!("Unable to allocate a workspace name")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_pr_sync::PrSyncState;
    use crate::workspace_status::WorkspaceStatus;

    fn fixture_record(mode: WorkspaceMode, root_path: Option<String>) -> WorkspaceRecord {
        WorkspaceRecord {
            id: "ws-1".to_string(),
            repo_id: "repo-1".to_string(),
            repo_name: "demo".to_string(),
            remote_url: None,
            default_branch: Some("main".to_string()),
            root_path,
            directory_name: "cebu".to_string(),
            state: crate::workspace_state::WorkspaceState::Ready,
            has_unread: false,
            workspace_unread: 0,
            unread_session_count: 0,
            status: WorkspaceStatus::InProgress,
            branch: Some("nathan/cebu".to_string()),
            initialization_parent_branch: Some("main".to_string()),
            intended_target_branch: Some("main".to_string()),
            mode,
            pinned_at: None,
            active_session_id: None,
            active_session_title: None,
            active_session_agent_type: None,
            active_session_status: None,
            primary_session_id: None,
            primary_session_title: None,
            primary_session_agent_type: None,
            pr_title: None,
            pr_sync_state: PrSyncState::None,
            pr_url: None,
            archive_commit: None,
            session_count: 0,
            message_count: 0,
            remote: Some("origin".to_string()),
            forge_provider: None,
            forge_login: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            last_user_message_at: None,
        }
    }

    #[test]
    fn workspace_path_for_worktree_uses_data_dir() {
        let _guard = crate::data_dir::TEST_ENV_LOCK.lock();
        let temp = tempfile::TempDir::new().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", temp.path());
        let record = fixture_record(WorkspaceMode::Worktree, None);
        let path = workspace_path(&record).unwrap();
        assert_eq!(
            path,
            temp.path().join("workspaces").join("demo").join("cebu")
        );
        std::env::remove_var("HELMOR_DATA_DIR");
    }

    #[test]
    fn workspace_path_for_local_uses_repo_root() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().join("my-repo");
        let record = fixture_record(WorkspaceMode::Local, Some(root.display().to_string()));
        let path = workspace_path(&record).unwrap();
        assert_eq!(path, root);
    }

    #[test]
    fn workspace_path_for_local_errors_without_root_path() {
        let record = fixture_record(WorkspaceMode::Local, None);
        let err = workspace_path(&record).unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("local") && msg.contains("root_path"),
            "unexpected error: {msg}"
        );
    }

    #[test]
    fn humanize_directory_name_capitalizes_segments() {
        assert_eq!(humanize_directory_name("hello-world"), "Hello World");
        assert_eq!(humanize_directory_name("fix_chat_list"), "Fix Chat List");
        assert_eq!(humanize_directory_name("cambridge"), "Cambridge");
    }

    #[test]
    fn humanize_directory_name_handles_empty_and_numbers() {
        assert_eq!(humanize_directory_name("a--b"), "A B");
        assert_eq!(humanize_directory_name(""), "");
        assert_eq!(humanize_directory_name("v2-release"), "V2 Release");
    }

    #[test]
    fn live_branch_label_returns_stored_value_for_worktree_mode() {
        let record = fixture_record(WorkspaceMode::Worktree, None);
        // Worktree mode never re-reads HEAD — stored snapshot wins.
        assert_eq!(live_branch_label(&record), Some("nathan/cebu".to_string()));
    }

    #[test]
    fn live_branch_label_falls_back_to_stored_for_local_when_path_missing() {
        let record = fixture_record(WorkspaceMode::Local, None);
        assert_eq!(live_branch_label(&record), Some("nathan/cebu".to_string()));
    }

    #[test]
    fn live_branch_label_returns_actual_head_for_local_mode() {
        // A local workspace's stored `branch` is just a snapshot. Once
        // the user (or another local create) checks out a different
        // branch in the same repo, the snapshot goes stale —
        // `live_branch_label` must return the current HEAD instead.
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path();
        let root_str = root.to_str().unwrap();
        git_ops::run_git(["init", "-b", "main", root_str], None).unwrap();
        std::fs::write(root.join("f.txt"), "x").unwrap();
        git_ops::run_git(["-C", root_str, "add", "f.txt"], None).unwrap();
        git_ops::run_git(
            [
                "-C",
                root_str,
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Helmor",
                "-c",
                "user.email=h@example.com",
                "commit",
                "-m",
                "initial",
            ],
            None,
        )
        .unwrap();
        // Snapshot says `main` (matches HEAD initially).
        let mut record = fixture_record(WorkspaceMode::Local, Some(root.display().to_string()));
        record.branch = Some("main".to_string());
        assert_eq!(live_branch_label(&record), Some("main".to_string()));

        // Now check out a different branch — stored snapshot is stale.
        git_ops::run_git(["-C", root_str, "checkout", "-b", "other"], None).unwrap();
        // Stored value still says `main`, but live HEAD wins.
        assert_eq!(live_branch_label(&record), Some("other".to_string()));
    }

    #[test]
    fn live_branch_label_freezes_for_archived_local_workspace() {
        // Archived → snapshot, not live HEAD.
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path();
        let root_str = root.to_str().unwrap();
        git_ops::run_git(["init", "-b", "main", root_str], None).unwrap();
        std::fs::write(root.join("f.txt"), "x").unwrap();
        git_ops::run_git(["-C", root_str, "add", "f.txt"], None).unwrap();
        git_ops::run_git(
            [
                "-C",
                root_str,
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Helmor",
                "-c",
                "user.email=h@example.com",
                "commit",
                "-m",
                "initial",
            ],
            None,
        )
        .unwrap();

        let mut record = fixture_record(WorkspaceMode::Local, Some(root.display().to_string()));
        record.branch = Some("feature/foo".to_string());
        record.state = crate::workspace_state::WorkspaceState::Archived;

        // User has since switched the local repo to `main`.
        git_ops::run_git(["-C", root_str, "checkout", "-b", "main-2"], None).unwrap();
        // Archived label must STILL be the snapshot value.
        assert_eq!(live_branch_label(&record), Some("feature/foo".to_string()));
    }

    #[test]
    fn non_empty_filters_blank_strings() {
        assert!(non_empty(&None).is_none());
        assert!(non_empty(&Some(String::new())).is_none());
        assert!(non_empty(&Some("   ".to_string())).is_none());
        assert_eq!(non_empty(&Some("hello".to_string())), Some("hello"));
    }

    #[test]
    fn group_id_maps_statuses_correctly() {
        assert_eq!(group_id_from_status(WorkspaceStatus::Done), "done");
        assert_eq!(group_id_from_status(WorkspaceStatus::Review), "review");
        assert_eq!(
            group_id_from_status(WorkspaceStatus::InProgress),
            "progress"
        );
        assert_eq!(group_id_from_status(WorkspaceStatus::Backlog), "backlog");
        assert_eq!(group_id_from_status(WorkspaceStatus::Canceled), "canceled");
    }

    #[test]
    fn auto_generated_branch_name_accepts_version_suffixes() {
        let settings = crate::settings::EffectiveBranchPrefixSettings {
            branch_prefix_type: Some(crate::settings::BranchPrefixType::Custom),
            branch_prefix_custom: Some("user/".to_string()),
            forge_provider: Some("github".to_string()),
            remote_url: None,
            forge_login: None,
        };

        assert!(is_auto_generated_branch_name(
            "user/vega",
            "vega",
            &settings
        ));
        assert!(is_auto_generated_branch_name(
            "user/vega-v1",
            "vega",
            &settings
        ));
        assert!(is_auto_generated_branch_name(
            "user/vega-v12",
            "vega",
            &settings
        ));
        assert!(!is_auto_generated_branch_name(
            "user/vega-feature",
            "vega",
            &settings
        ));
    }

    #[test]
    fn repo_initials_two_segments() {
        assert_eq!(repo_initials_for_name("my-project"), "MP");
        assert_eq!(repo_initials_for_name("hello_world"), "HW");
    }

    #[test]
    fn repo_initials_single_word() {
        assert_eq!(repo_initials_for_name("helmor"), "HE");
    }

    #[test]
    fn repo_initials_fallback() {
        assert_eq!(repo_initials_for_name("---"), "WS");
        assert_eq!(repo_initials_for_name(""), "WS");
    }

    #[test]
    fn repo_icon_mime_type_detection() {
        assert_eq!(repo_icon_mime_type(Path::new("icon.svg")), "image/svg+xml");
        assert_eq!(repo_icon_mime_type(Path::new("icon.ico")), "image/x-icon");
        assert_eq!(repo_icon_mime_type(Path::new("icon.png")), "image/png");
        assert_eq!(repo_icon_mime_type(Path::new("icon.jpg")), "image/png");
    }

    #[test]
    fn repo_icon_path_returns_none_for_empty() {
        assert!(repo_icon_path_for_root_path(None).is_none());
        assert!(repo_icon_path_for_root_path(Some("")).is_none());
        assert!(repo_icon_path_for_root_path(Some("   ")).is_none());
    }

    // ---- Workspace naming tests ----

    fn test_db() -> (rusqlite::Connection, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO repos (id, name) VALUES ('r1', 'test-repo')",
            [],
        )
        .unwrap();
        (conn, dir)
    }

    #[test]
    fn workspace_names_list_is_not_empty() {
        assert!(WORKSPACE_NAMES.iter().all(|name| !name.is_empty()));
    }

    #[test]
    fn workspace_names_are_all_lowercase() {
        for name in WORKSPACE_NAMES {
            assert_eq!(
                *name,
                name.to_ascii_lowercase(),
                "Name should be lowercase: {name}"
            );
        }
    }

    #[test]
    fn workspace_names_have_no_duplicates() {
        let mut seen = std::collections::HashSet::new();
        for name in WORKSPACE_NAMES {
            assert!(seen.insert(*name), "Duplicate workspace name: {name}");
        }
    }

    #[test]
    fn allocate_picks_from_workspace_names() {
        let (conn, _dir) = test_db();
        let name = allocate_directory_name_with_conn(&conn, "r1").unwrap();
        assert!(
            WORKSPACE_NAMES.contains(&name.as_str()),
            "Allocated name should be from WORKSPACE_NAMES: {name}"
        );
    }

    #[test]
    fn allocate_avoids_used_names() {
        let (conn, _dir) = test_db();

        // Use all names except one
        let reserved = WORKSPACE_NAMES.last().unwrap();
        for name in &WORKSPACE_NAMES[..WORKSPACE_NAMES.len() - 1] {
            conn.execute(
                "INSERT INTO workspaces (id, repository_id, directory_name) VALUES (?1, 'r1', ?2)",
                [&uuid::Uuid::new_v4().to_string(), &name.to_string()],
            )
            .unwrap();
        }

        // The only available name should be the reserved one
        let allocated = allocate_directory_name_with_conn(&conn, "r1").unwrap();
        assert_eq!(allocated, *reserved, "Should pick the only remaining name");
    }

    #[test]
    fn allocate_uses_v2_suffix_when_all_taken() {
        let (conn, _dir) = test_db();

        // Use all names
        for name in WORKSPACE_NAMES {
            conn.execute(
                "INSERT INTO workspaces (id, repository_id, directory_name) VALUES (?1, 'r1', ?2)",
                [&uuid::Uuid::new_v4().to_string(), &name.to_string()],
            )
            .unwrap();
        }

        let allocated = allocate_directory_name_with_conn(&conn, "r1").unwrap();
        assert!(
            allocated.ends_with("-v2"),
            "Should have -v2 suffix when all names taken: {allocated}"
        );
        // The base name (before -v2) should be from the list
        let base = allocated.strip_suffix("-v2").unwrap();
        assert!(
            WORKSPACE_NAMES.contains(&base),
            "Base name should be from WORKSPACE_NAMES: {base}"
        );
    }

    #[test]
    fn allocate_is_random_not_sequential() {
        let (_conn, _dir) = test_db();

        // Allocate multiple names and check they're not always the same order
        let mut first_picks = std::collections::HashSet::new();
        for _ in 0..10 {
            // Use a fresh DB each time to get the first pick
            let (c, _d) = test_db();
            let name = allocate_directory_name_with_conn(&c, "r1").unwrap();
            first_picks.insert(name);
        }

        // With 90 names and 10 picks, randomness should give us at least 2 different names
        assert!(
            first_picks.len() >= 2,
            "Expected random picks but got only: {:?}",
            first_picks
        );
    }

    #[test]
    fn allocate_is_case_insensitive() {
        let (conn, _dir) = test_db();

        // Insert with uppercase — should still be recognized as used
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name) VALUES ('w1', 'r1', 'MERCURY')",
            [],
        )
        .unwrap();

        // Allocate many times — "mercury" should never be picked
        for _ in 0..20 {
            let name = allocate_directory_name_with_conn(&conn, "r1").unwrap();
            assert_ne!(
                name, "mercury",
                "Should not pick 'mercury' when 'MERCURY' is already used"
            );
        }
    }

    #[test]
    fn allocate_scoped_to_repo() {
        let (conn, _dir) = test_db();
        conn.execute(
            "INSERT INTO repos (id, name) VALUES ('r2', 'other-repo')",
            [],
        )
        .unwrap();

        // Use "mercury" in repo r2
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name) VALUES ('w1', 'r2', 'mercury')",
            [],
        )
        .unwrap();

        // Use all names EXCEPT "mercury" in r1 — forces the only possible pick
        for name in WORKSPACE_NAMES {
            if *name == "mercury" {
                continue;
            }
            conn.execute(
                "INSERT INTO workspaces (id, repository_id, directory_name) VALUES (?1, 'r1', ?2)",
                [&uuid::Uuid::new_v4().to_string(), &name.to_string()],
            )
            .unwrap();
        }

        // r1's only available name is "mercury" — even though r2 uses it
        let name = allocate_directory_name_with_conn(&conn, "r1").unwrap();
        assert_eq!(
            name, "mercury",
            "Names are per-repo, so r1 can still use 'mercury'"
        );
    }
}
