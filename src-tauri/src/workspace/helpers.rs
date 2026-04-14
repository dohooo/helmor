use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

use crate::models::workspaces::WorkspaceRecord;

// ---- Display / naming helpers ----

pub fn display_title(record: &WorkspaceRecord) -> String {
    if let Some(pr_title) = non_empty(&record.pr_title) {
        return pr_title.to_string();
    }

    if let Some(session_title) = non_empty(&record.active_session_title) {
        if session_title != "Untitled" {
            return session_title.to_string();
        }
    }

    humanize_directory_name(&record.directory_name)
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

// ---- Sidebar sorting helpers ----

pub fn group_id_from_status(manual_status: &Option<String>, derived_status: &str) -> &'static str {
    let status = non_empty(manual_status)
        .unwrap_or(derived_status)
        .trim()
        .to_ascii_lowercase();

    match status.as_str() {
        "done" => "done",
        "review" | "in-review" => "review",
        "backlog" => "backlog",
        "cancelled" | "canceled" => "canceled",
        _ => "progress",
    }
}

pub fn sidebar_sort_rank(record: &WorkspaceRecord) -> usize {
    match group_id_from_status(&record.manual_status, &record.derived_status) {
        "done" => 0,
        "review" => 1,
        "progress" => 2,
        "backlog" => 3,
        "canceled" => 4,
        _ => 5,
    }
}

// ---- Repo icon helpers ----

const REPO_ICON_CANDIDATES: &[&str] = &[
    "public/apple-touch-icon.png",
    "apple-touch-icon.png",
    "public/favicon.svg",
    "favicon.svg",
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

#[cfg(unix)]
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

#[cfg(not(unix))]
pub fn copy_symlink(source: &Path, destination: &Path) -> Result<()> {
    let target = fs::read_link(source)
        .with_context(|| format!("Failed to read symlink {}", source.display()))?;
    let resolved = source
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join(target);
    copy_dir_all(&resolved, destination)
}

// ---- Workspace scaffolding helpers ----

pub fn write_file_if_missing(path: &Path, contents: &str) -> Result<()> {
    if path.exists() {
        return Ok(());
    }

    fs::write(path, contents)
        .with_context(|| format!("Failed to write scaffold file {}", path.display()))
}

pub fn create_workspace_context_scaffold(workspace_dir: &Path) -> Result<()> {
    let context_dir = workspace_dir.join(".context");
    let attachments_dir = context_dir.join("attachments");
    fs::create_dir_all(&attachments_dir).with_context(|| {
        format!(
            "Failed to create workspace context scaffold under {}",
            context_dir.display()
        )
    })?;

    write_file_if_missing(&context_dir.join("notes.md"), "# Notes\n")?;
    write_file_if_missing(&context_dir.join("todos.md"), "# Todos\n")?;

    Ok(())
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
    settings: &crate::settings::BranchPrefixSettings,
) -> String {
    let prefix_type = settings
        .branch_prefix_type
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase());

    let prefix = match prefix_type.as_deref() {
        Some("custom") => settings
            .branch_prefix_custom
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("")
            .to_string(),
        Some("none") => String::new(),
        // Default: use GitHub login as prefix (e.g., "username/")
        _ => {
            if let Ok(Some(login)) = resolve_github_login() {
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
    settings: &crate::settings::BranchPrefixSettings,
) -> bool {
    branch == branch_name_for_directory(directory_name, settings)
}

/// Read the GitHub login from the stored identity metadata.
fn resolve_github_login() -> Result<Option<String>> {
    let raw = crate::settings::load_setting_value("github_identity_meta")?;
    let raw = match raw {
        Some(v) => v,
        None => return Ok(None),
    };
    let meta: serde_json::Value = serde_json::from_str(&raw)?;
    Ok(meta.get("login").and_then(|v| v.as_str()).map(String::from))
}

pub fn allocate_directory_name_for_repo(repo_id: &str) -> Result<String> {
    let connection = crate::db::open_connection(false)?;
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

// ---- Archive helpers ----

pub fn staged_archive_context_dir(archived_context_dir: &Path) -> PathBuf {
    archived_context_dir.with_file_name(format!(
        ".{}-restore-staged-{}",
        archived_context_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("workspace"),
        uuid::Uuid::new_v4()
    ))
}

pub fn attachment_prefix(path: &Path) -> String {
    let mut prefix = path.display().to_string();
    if !prefix.ends_with('/') {
        prefix.push('/');
    }
    prefix
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn non_empty_filters_blank_strings() {
        assert!(non_empty(&None).is_none());
        assert!(non_empty(&Some(String::new())).is_none());
        assert!(non_empty(&Some("   ".to_string())).is_none());
        assert_eq!(non_empty(&Some("hello".to_string())), Some("hello"));
    }

    #[test]
    fn group_id_maps_statuses_correctly() {
        assert_eq!(group_id_from_status(&None, "done"), "done");
        assert_eq!(group_id_from_status(&None, "review"), "review");
        assert_eq!(group_id_from_status(&None, "in-review"), "review");
        assert_eq!(group_id_from_status(&None, "in-progress"), "progress");
        assert_eq!(group_id_from_status(&None, "backlog"), "backlog");
        assert_eq!(group_id_from_status(&None, "canceled"), "canceled");
        assert_eq!(group_id_from_status(&None, "cancelled"), "canceled");
        assert_eq!(group_id_from_status(&None, "unknown"), "progress");
    }

    #[test]
    fn group_id_prefers_manual_status() {
        let manual = Some("done".to_string());
        assert_eq!(group_id_from_status(&manual, "in-progress"), "done");
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
