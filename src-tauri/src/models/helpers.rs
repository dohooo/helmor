use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::Row;

use super::workspaces::WorkspaceRecord;

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

pub fn sort_sidebar_rows(rows: &mut [super::workspaces::WorkspaceSidebarRow]) {
    rows.sort_by(|left, right| left.title.to_lowercase().cmp(&right.title.to_lowercase()));
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
    let icon_path = repo_icon_path_for_root_path(root_path)?;
    let mime_type = repo_icon_mime_type(Path::new(&icon_path));
    let bytes = fs::read(icon_path).ok()?;

    Some(format!(
        "data:{mime_type};base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
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

pub const STAR_PROPER_NAMES: &[&str] = &[
    "acamar",
    "achernar",
    "acrux",
    "adhafera",
    "adhara",
    "ain",
    "albali",
    "albireo",
    "alkaid",
    "alkalurops",
    "alkaphrah",
    "alpheratz",
    "alrakis",
    "altair",
    "alya",
    "ancha",
    "ankaa",
    "antares",
    "aran",
    "arcturus",
    "aspidiske",
    "atik",
    "atria",
    "avior",
    "bellatrix",
    "betelgeuse",
    "canopus",
    "capella",
    "castor",
    "cebalrai",
    "deneb",
    "denebola",
    "diadem",
    "diphda",
    "electra",
    "elnath",
    "enif",
    "etamin",
    "fomalhaut",
    "furud",
    "gacrux",
    "gienah",
    "hamal",
    "hassaleh",
    "hydrobius",
    "izar",
    "jabbah",
    "kaus",
    "kochab",
    "lesath",
    "maia",
    "markab",
    "meissa",
    "menkalinan",
    "merak",
    "miaplacidus",
    "mimosa",
    "mintaka",
    "mirach",
    "mirfak",
    "mizar",
    "naos",
    "nashira",
    "nunki",
    "peacock",
    "phact",
    "phecda",
    "pleione",
    "polaris",
    "pollux",
    "procyon",
    "propus",
    "regulus",
    "rigel",
    "rotanev",
    "sabik",
    "sadr",
    "saiph",
    "scheat",
    "schedar",
    "secunda",
    "sham",
    "sheliak",
    "sirius",
    "spica",
    "sualocin",
    "suhail",
    "tarazed",
    "tejat",
    "thuban",
    "unukalhai",
    "vega",
    "wezen",
    "yildun",
    "zaniah",
    "zaurak",
    "zubenelgenubi",
];

pub fn branch_name_for_directory(
    directory_name: &str,
    settings: &super::settings::BranchPrefixSettings,
) -> String {
    let prefix = match settings
        .branch_prefix_type
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("custom") => settings
            .branch_prefix_custom
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(""),
        _ => "",
    };

    format!("{prefix}{directory_name}")
}

pub fn allocate_directory_name_for_repo(repo_id: &str) -> Result<String> {
    let connection = super::db::open_connection(false)?;
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

    for star_name in STAR_PROPER_NAMES {
        if !used.contains(*star_name) {
            return Ok((*star_name).to_string());
        }
    }

    for version in 2..=999 {
        for star_name in STAR_PROPER_NAMES {
            let candidate = format!("{star_name}-v{version}");
            if !used.contains(candidate.as_str()) {
                return Ok(candidate);
            }
        }
    }

    bail!("Unable to allocate a workspace name from the vendored star list")
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

// ---- Row mapper ----

pub fn workspace_record_from_row(row: &Row<'_>) -> rusqlite::Result<WorkspaceRecord> {
    Ok(WorkspaceRecord {
        id: row.get(0)?,
        repo_id: row.get(1)?,
        repo_name: row.get(2)?,
        remote_url: row.get(3)?,
        default_branch: row.get(4)?,
        root_path: row.get(5)?,
        directory_name: row.get(6)?,
        state: row.get(7)?,
        has_unread: row.get::<_, i64>(8)? != 0,
        workspace_unread: row.get(9)?,
        session_unread_total: row.get(10)?,
        unread_session_count: row.get(11)?,
        derived_status: row.get(12)?,
        manual_status: row.get(13)?,
        branch: row.get(14)?,
        initialization_parent_branch: row.get(15)?,
        intended_target_branch: row.get(16)?,
        notes: row.get(17)?,
        pinned_at: row.get(18)?,
        active_session_id: row.get(19)?,
        active_session_title: row.get(20)?,
        active_session_agent_type: row.get(21)?,
        active_session_status: row.get(22)?,
        pr_title: row.get(23)?,
        pr_description: row.get(24)?,
        archive_commit: row.get(25)?,
        session_count: row.get(26)?,
        message_count: row.get(27)?,
        attachment_count: row.get(28)?,
    })
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
}
