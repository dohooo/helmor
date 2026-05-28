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
/// directly on the source repo's root path; Chat workspaces store
/// their relative scratch path (`"YYYY-MM-DD/new-chat[-N]"`) in
/// `directory_name` and resolve it under the `chats` data dir.
pub fn workspace_path(record: &WorkspaceRecord) -> Result<PathBuf> {
    match record.mode {
        WorkspaceMode::Worktree => {
            crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)
        }
        WorkspaceMode::Local => non_empty(&record.root_path)
            .map(PathBuf::from)
            .with_context(|| format!("Workspace {} (local) is missing repo root_path", record.id)),
        WorkspaceMode::Chat => {
            let dir_name = record.directory_name.trim();
            if dir_name.is_empty() {
                bail!("Workspace {} (chat) is missing directory_name", record.id);
            }
            Ok(crate::data_dir::chats_dir()?.join(dir_name))
        }
    }
}

// ---- Display / naming helpers ----

pub fn display_title(record: &WorkspaceRecord) -> String {
    if let Some(pr_title) = non_empty(&record.pr_title) {
        return pr_title.to_string();
    }

    // Local workspaces don't own a `directory_name` (they share the
    // user's repo root with potentially other local workspaces). Chat
    // workspaces own a synthetic directory name like
    // `"YYYY-MM-DD/new-chat-N"` which doesn't humanize nicely. Both
    // prefer the live session title when one is available, falling
    // back to a generic placeholder rather than the directory name.
    if matches!(record.mode, WorkspaceMode::Local | WorkspaceMode::Chat) {
        if let Some(title) = non_empty(&record.primary_session_title)
            .or_else(|| non_empty(&record.active_session_title))
        {
            if title != "Untitled" {
                return title.to_string();
            }
        }
        return if record.mode == WorkspaceMode::Chat {
            "New chat".to_string()
        } else {
            record.repo_name.clone()
        };
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
    // Explicit Helmor override — always wins. Drop a file here in monorepos
    // (or any repo where automatic detection picks the wrong icon).
    ".helmor/icon.svg",
    ".helmor/icon.png",
    // Single-package conventions.
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

/// Cache value: the resolved `data:` URI plus the mtime of the source file at
/// the time we read it. The mtime lets us cheaply invalidate when the user
/// edits / commits a new icon without restarting the app.
#[derive(Clone)]
struct CachedIcon {
    /// Path we read the icon from (so a later override file taking precedence
    /// also invalidates this entry).
    source_path: String,
    /// `mtime` of `source_path` when we last read it. `None` if `metadata()`
    /// failed — in that case we treat the entry as always-stale.
    mtime: Option<std::time::SystemTime>,
    data_uri: Option<String>,
}

static REPO_ICON_SRC_CACHE: LazyLock<Mutex<HashMap<String, CachedIcon>>> =
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

    let icon_path = repo_icon_path_for_root_path(Some(root_path));
    let current_mtime = icon_path
        .as_deref()
        .and_then(|path| fs::metadata(path).ok())
        .and_then(|metadata| metadata.modified().ok());

    // Reuse the cached entry only if (a) the resolved icon path is unchanged
    // (e.g. a user didn't add a higher-priority candidate like
    // `.helmor/icon.svg`) and (b) the file's mtime hasn't moved. We bail out
    // of the cache on any uncertainty (missing metadata) so editing an icon
    // never strands a stale `data:` URI in the UI.
    if let Ok(cache) = REPO_ICON_SRC_CACHE.lock() {
        if let Some(cached) = cache.get(root_path) {
            let path_matches = icon_path.as_deref() == Some(cached.source_path.as_str());
            let mtime_matches = match (cached.mtime, current_mtime) {
                (Some(cached_mtime), Some(current)) => cached_mtime == current,
                _ => false,
            };

            if path_matches && mtime_matches {
                return cached.data_uri.clone();
            }

            // Negative cache: both sides agree there's no icon. Cheap to
            // keep; saves a directory walk per workspace summary refresh.
            if icon_path.is_none() && cached.source_path.is_empty() {
                return cached.data_uri.clone();
            }
        }
    }

    let data_uri = icon_path.as_deref().and_then(|path| {
        let mime_type = repo_icon_mime_type(Path::new(path));
        let bytes = fs::read(path).ok()?;
        Some(format!(
            "data:{mime_type};base64,{}",
            BASE64_STANDARD.encode(bytes)
        ))
    });

    if let Ok(mut cache) = REPO_ICON_SRC_CACHE.lock() {
        cache.insert(
            root_path.to_string(),
            CachedIcon {
                source_path: icon_path.clone().unwrap_or_default(),
                mtime: current_mtime,
                data_uri: data_uri.clone(),
            },
        );
    }

    data_uri
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

/// Allocate a fresh scratch directory for a Chat-mode workspace.
///
/// Layout: `<data_dir>/chats/<YYYY-MM-DD>/<name>` where `<name>` starts
/// at `new-chat`, then `new-chat-1`, `new-chat-2`, ... — a slot is free
/// only when BOTH the filesystem dir is absent AND no DB row already
/// owns the same relative `directory_name`. Checking only the FS would
/// re-issue a name to a new row whenever the user manually deletes a
/// chat directory while the DB row still exists, causing two rows to
/// resolve to the same `workspace_path`.
///
/// Creates the dir on disk before returning so the caller can immediately
/// use it as a CLI `cwd`. Returns `(directory_name, absolute_path)`.
pub fn allocate_chat_workspace_dir() -> Result<(String, PathBuf)> {
    let today = chrono::Local::now().date_naive().to_string(); // "YYYY-MM-DD"
    let date_dir = crate::data_dir::chats_dir()?.join(&today);
    fs::create_dir_all(&date_dir).with_context(|| {
        format!(
            "Failed to create chat date directory {}",
            date_dir.display()
        )
    })?;

    // Snapshot every chat row's `directory_name` once up-front. The
    // alternative — one COUNT query per candidate — is fine for 9999
    // iterations but allocates a connection per loop tick.
    let connection = crate::db::read_conn()?;
    let mut used_names: std::collections::HashSet<String> = connection
        .prepare(
            "SELECT directory_name FROM workspaces \
             WHERE COALESCE(mode, 'worktree') = 'chat' \
               AND directory_name IS NOT NULL",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<_, _>>()?;
    drop(connection);

    // Allocate first un-taken slot. Cap at 9999 to avoid pathological
    // loops; the user would have to spin up a chat per minute for a
    // week to hit it.
    for index in 0..=9999 {
        let candidate_name = if index == 0 {
            "new-chat".to_string()
        } else {
            format!("new-chat-{index}")
        };
        let relative = format!("{today}/{candidate_name}");
        if used_names.contains(&relative) {
            continue;
        }
        let candidate_path = date_dir.join(&candidate_name);
        if !candidate_path.exists() {
            fs::create_dir(&candidate_path).with_context(|| {
                format!(
                    "Failed to create chat workspace directory {}",
                    candidate_path.display()
                )
            })?;
            // Reserve the name in-memory in case a future call inside
            // the same process iterates here before the new row lands
            // in the DB read snapshot.
            used_names.insert(relative.clone());
            return Ok((relative, candidate_path));
        }
    }

    bail!("Unable to allocate a chat workspace directory under {date_dir:?}")
}

fn lookup_repo_name(connection: &rusqlite::Connection, repo_id: &str) -> Result<Option<String>> {
    let mut stmt = connection
        .prepare("SELECT name FROM repos WHERE id = ?1")
        .context("Failed to prepare repo name lookup")?;
    let mut rows = stmt
        .query_map([repo_id], |row| row.get::<_, String>(0))
        .context("Failed to query repo name")?;
    match rows.next() {
        Some(name) => Ok(Some(name?)),
        None => Ok(None),
    }
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

    let mut used = names
        .into_iter()
        .map(|value| value.to_ascii_lowercase())
        .collect::<std::collections::HashSet<_>>();

    // Also exclude any directory names that already exist on disk under the
    // repo's workspace root. Orphan dirs (DB row gone but folder still on
    // disk) would otherwise cause `prepare → finalize` to fail later with a
    // "target already exists" error.
    if let Some(repo_name) = lookup_repo_name(connection, repo_id)? {
        if let Ok(workspaces_root) = crate::data_dir::workspace_dir(&repo_name, "") {
            if let Ok(entries) = std::fs::read_dir(&workspaces_root) {
                for entry in entries.flatten() {
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        if let Some(name) = entry.file_name().to_str() {
                            used.insert(name.to_ascii_lowercase());
                        }
                    }
                }
            }
        }
    }

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
            branch_intent: crate::workspace_state::WorkspaceBranchIntent::FromBranch,
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
            display_order: crate::workspace::sidebar_order::ORDER_STEP,
            repo_sidebar_order: crate::workspace::sidebar_order::ORDER_STEP,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            last_user_message_at: None,
            setup_completed_at: None,
            active_run_action_id: None,
            kind: "manual".to_string(),
            ai_priming_consumed: false,
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
    fn workspace_path_for_chat_joins_chats_dir() {
        let _guard = crate::data_dir::TEST_ENV_LOCK.lock();
        let temp = tempfile::TempDir::new().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", temp.path());
        let mut record = fixture_record(WorkspaceMode::Chat, None);
        record.directory_name = "2026-05-19/new-chat".to_string();
        let path = workspace_path(&record).unwrap();
        assert_eq!(
            path,
            temp.path()
                .join("chats")
                .join("2026-05-19")
                .join("new-chat")
        );
        std::env::remove_var("HELMOR_DATA_DIR");
    }

    #[test]
    fn allocate_chat_workspace_dir_creates_unique_names() {
        // `allocate_chat_workspace_dir` now consults the `workspaces`
        // table to avoid handing out a name an orphaned DB row already
        // owns, so the test needs a real schema-initialised env.
        let _env = crate::testkit::TestEnv::new("alloc-chat-dir-unique");

        let (name1, path1) = allocate_chat_workspace_dir().unwrap();
        let (name2, path2) = allocate_chat_workspace_dir().unwrap();
        let (name3, path3) = allocate_chat_workspace_dir().unwrap();

        // First allocation gets the bare `new-chat`; subsequent ones
        // append `-1`, `-2`. Date prefix is `YYYY-MM-DD/`.
        assert!(
            name1.ends_with("/new-chat"),
            "expected first to end with /new-chat: {name1}"
        );
        assert!(
            name2.ends_with("/new-chat-1"),
            "expected second to end with /new-chat-1: {name2}"
        );
        assert!(
            name3.ends_with("/new-chat-2"),
            "expected third to end with /new-chat-2: {name3}"
        );
        assert!(path1.is_dir(), "first dir should exist: {path1:?}");
        assert!(path2.is_dir(), "second dir should exist: {path2:?}");
        assert!(path3.is_dir(), "third dir should exist: {path3:?}");
    }

    #[test]
    fn allocate_chat_workspace_dir_skips_orphaned_db_name() {
        // Simulate the failure mode from the review: a DB row still
        // points at "new-chat" but the user wiped the dir. The allocator
        // must NOT hand the same slot to a fresh chat — otherwise two
        // rows resolve to the same workspace_path and one's delete
        // would clobber the other's contents.
        let env = crate::testkit::TestEnv::new("alloc-chat-skips-orphan");
        let today = chrono::Local::now().date_naive().to_string();
        let orphan_directory_name = format!("{today}/new-chat");

        // Seed an orphan chat row with the slot we expect to be skipped.
        let conn = env.db_connection();
        conn.execute(
            "INSERT OR IGNORE INTO repos (id, name, hidden, display_order) \
             VALUES (?1, ?2, 1, ?3)",
            rusqlite::params![
                crate::models::repos::SYSTEM_CHAT_REPO_ID,
                crate::models::repos::SYSTEM_CHAT_REPO_NAME,
                i64::MIN,
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name, mode, state, status, display_order) \
             VALUES ('orphan', ?1, ?2, 'chat', 'ready', 'in-progress', ?3)",
            rusqlite::params![
                crate::models::repos::SYSTEM_CHAT_REPO_ID,
                &orphan_directory_name,
                crate::workspace::sidebar_order::ORDER_STEP,
            ],
        )
        .unwrap();

        let (name, _path) = allocate_chat_workspace_dir().unwrap();
        assert_ne!(
            name, orphan_directory_name,
            "must not reuse a slot owned by an existing chat row"
        );
        assert!(
            name.ends_with("/new-chat-1"),
            "should fall through to the next free slot, got {name}"
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

    #[test]
    fn repo_icon_path_prefers_helmor_override_over_favicon() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Existing single-package favicon.
        fs::create_dir_all(root.join("public")).unwrap();
        fs::write(root.join("public/favicon.svg"), b"<svg/>").unwrap();

        // Higher-priority Helmor override.
        fs::create_dir_all(root.join(".helmor")).unwrap();
        fs::write(root.join(".helmor/icon.svg"), b"<svg id=\"override\"/>").unwrap();

        let resolved = repo_icon_path_for_root_path(Some(root.to_str().unwrap()))
            .expect("expected an icon to resolve");
        assert!(
            resolved.ends_with(".helmor/icon.svg"),
            "expected `.helmor/icon.svg` to win, got {resolved}"
        );
    }

    #[test]
    fn repo_icon_path_returns_none_for_unknown_subdir_layouts() {
        // No automatic monorepo detection — repos with apps under
        // `apps/<name>/public/...` or `applications/<name>/public/...` get
        // initials-only avatars unless the user drops a `.helmor/icon.*`.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        fs::create_dir_all(root.join("apps/web/public")).unwrap();
        fs::write(root.join("apps/web/public/favicon.svg"), b"<svg/>").unwrap();
        fs::create_dir_all(root.join("applications/next-app/public")).unwrap();
        fs::write(
            root.join("applications/next-app/public/favicon.ico"),
            b"\0\0",
        )
        .unwrap();

        assert!(repo_icon_path_for_root_path(Some(root.to_str().unwrap())).is_none());
    }

    #[test]
    fn repo_icon_src_picks_up_higher_priority_override_without_restart() {
        let dir = tempfile::tempdir().unwrap();
        let root_str = dir.path().to_str().unwrap().to_string();

        // First pass: only the low-priority favicon exists.
        fs::create_dir_all(dir.path().join("public")).unwrap();
        fs::write(
            dir.path().join("public/favicon.svg"),
            b"<svg id=\"first\"/>",
        )
        .unwrap();

        let initial =
            repo_icon_src_for_root_path(Some(&root_str)).expect("expected initial icon to resolve");
        assert!(initial.starts_with("data:image/svg+xml;base64,"));

        // Now drop in a `.helmor/icon.svg` override. The cache must notice
        // that the resolved path changed and serve the new contents — this
        // is the failure mode that motivated mtime-aware invalidation.
        fs::create_dir_all(dir.path().join(".helmor")).unwrap();
        fs::write(
            dir.path().join(".helmor/icon.svg"),
            b"<svg id=\"override\"/>",
        )
        .unwrap();

        let after_override = repo_icon_src_for_root_path(Some(&root_str))
            .expect("expected override icon to resolve");
        assert_ne!(
            initial, after_override,
            "cache must re-read when a higher-priority candidate appears"
        );
    }

    #[test]
    fn repo_icon_src_picks_up_in_place_edits_via_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let root_str = dir.path().to_str().unwrap().to_string();

        fs::create_dir_all(dir.path().join(".helmor")).unwrap();
        let icon_path = dir.path().join(".helmor/icon.svg");
        fs::write(&icon_path, b"<svg id=\"v1\"/>").unwrap();

        let v1 =
            repo_icon_src_for_root_path(Some(&root_str)).expect("expected initial icon to resolve");

        // Overwrite in place and bump mtime explicitly, so the test doesn't
        // depend on filesystem mtime resolution.
        fs::write(&icon_path, b"<svg id=\"v2\"/>").unwrap();
        let bumped = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&icon_path)
            .unwrap()
            .set_modified(bumped)
            .unwrap();

        let v2 =
            repo_icon_src_for_root_path(Some(&root_str)).expect("expected updated icon to resolve");
        assert_ne!(v1, v2, "cache must re-read when icon mtime changes");
    }

    #[test]
    fn repo_icon_src_returns_none_when_no_candidate_matches() {
        let dir = tempfile::tempdir().unwrap();
        let root_str = dir.path().to_str().unwrap().to_string();

        assert!(repo_icon_src_for_root_path(Some(&root_str)).is_none());
        // Second call exercises the negative-cache path.
        assert!(repo_icon_src_for_root_path(Some(&root_str)).is_none());
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
                "INSERT INTO workspaces (id, repository_id, directory_name, display_order) VALUES (?1, 'r1', ?2, ?3)",
                rusqlite::params![
                    &uuid::Uuid::new_v4().to_string(),
                    &name.to_string(),
                    crate::workspace::sidebar_order::ORDER_STEP
                ],
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
                "INSERT INTO workspaces (id, repository_id, directory_name, display_order) VALUES (?1, 'r1', ?2, ?3)",
                rusqlite::params![
                    &uuid::Uuid::new_v4().to_string(),
                    &name.to_string(),
                    crate::workspace::sidebar_order::ORDER_STEP
                ],
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
            "INSERT INTO workspaces (id, repository_id, directory_name, display_order) VALUES ('w1', 'r1', 'MERCURY', ?1)",
            [crate::workspace::sidebar_order::ORDER_STEP],
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
            "INSERT INTO workspaces (id, repository_id, directory_name, display_order) VALUES ('w1', 'r2', 'mercury', ?1)",
            [crate::workspace::sidebar_order::ORDER_STEP],
        )
        .unwrap();

        // Use all names EXCEPT "mercury" in r1 — forces the only possible pick
        for name in WORKSPACE_NAMES {
            if *name == "mercury" {
                continue;
            }
            conn.execute(
                "INSERT INTO workspaces (id, repository_id, directory_name, display_order) VALUES (?1, 'r1', ?2, ?3)",
                rusqlite::params![
                    &uuid::Uuid::new_v4().to_string(),
                    &name.to_string(),
                    crate::workspace::sidebar_order::ORDER_STEP
                ],
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

    /// `prepare → finalize` would otherwise fail with "target already exists"
    /// when a previous workspace's worktree got orphaned (DB row gone, dir
    /// still on disk). The allocator filters those out so the picked name's
    /// path is always fresh.
    #[test]
    fn allocate_skips_orphan_directories_on_disk() {
        let _guard = crate::data_dir::TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let temp = tempfile::TempDir::new().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", temp.path());

        let (conn, _db_dir) = test_db();
        // Squat *every* base name with a real directory under
        // `<data>/workspaces/test-repo/`. No DB rows exist, so without the
        // on-disk dedupe the allocator would happily pick any of them.
        let workspaces_root = temp.path().join("workspaces").join("test-repo");
        std::fs::create_dir_all(&workspaces_root).unwrap();
        for name in WORKSPACE_NAMES {
            std::fs::create_dir_all(workspaces_root.join(name)).unwrap();
        }

        let allocated = allocate_directory_name_with_conn(&conn, "r1").unwrap();
        // All base names taken on disk → must fall back to `-v2`.
        assert!(
            allocated.ends_with("-v2"),
            "Expected -v2 suffix when every base name is squatted by an orphan dir, got: {allocated}"
        );

        std::env::remove_var("HELMOR_DATA_DIR");
    }

    /// Regression guard for the on-disk dedupe: a single orphan directory
    /// must not be pickable. Asserts that across many attempts, the
    /// squatted name is never returned.
    #[test]
    fn allocate_never_returns_an_orphan_directory_name() {
        let _guard = crate::data_dir::TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let temp = tempfile::TempDir::new().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", temp.path());

        let (conn, _db_dir) = test_db();
        let workspaces_root = temp.path().join("workspaces").join("test-repo");
        std::fs::create_dir_all(&workspaces_root).unwrap();
        let squatted = WORKSPACE_NAMES.first().copied().unwrap();
        std::fs::create_dir_all(workspaces_root.join(squatted)).unwrap();

        for _ in 0..50 {
            let name = allocate_directory_name_with_conn(&conn, "r1").unwrap();
            assert_ne!(
                name, squatted,
                "Allocator must not return a name whose directory already exists on disk"
            );
        }

        std::env::remove_var("HELMOR_DATA_DIR");
    }

    /// Plain files (not directories) under the workspace root are NOT
    /// treated as squatters — they live alongside worktrees (e.g. a
    /// stray `.DS_Store`) without blocking name allocation. Documents
    /// the contract that `cleanup_after_worktree_failure` test relies on.
    #[test]
    fn allocate_ignores_plain_files_under_workspace_root() {
        let _guard = crate::data_dir::TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let temp = tempfile::TempDir::new().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", temp.path());

        let (conn, _db_dir) = test_db();
        let workspaces_root = temp.path().join("workspaces").join("test-repo");
        std::fs::create_dir_all(&workspaces_root).unwrap();
        // Squat every base name with a *file* (not a directory) — these
        // must NOT be filtered out by the on-disk dedupe.
        for name in WORKSPACE_NAMES {
            std::fs::write(workspaces_root.join(name), "stale").unwrap();
        }

        let allocated = allocate_directory_name_with_conn(&conn, "r1").unwrap();
        // Files don't block — allocator picks a base name (no -v2).
        assert!(
            !allocated.ends_with("-v2"),
            "Files under workspace root should not trigger -v2 fallback, got: {allocated}"
        );
        assert!(
            WORKSPACE_NAMES.contains(&allocated.as_str()),
            "Allocated name should still be from WORKSPACE_NAMES: {allocated}"
        );

        std::env::remove_var("HELMOR_DATA_DIR");
    }
}
