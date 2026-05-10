use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFileReadResponse {
    pub path: String,
    pub content: String,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFileStatResponse {
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
    pub mtime_ms: Option<i64>,
    pub size: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFileListItem {
    pub path: String,
    pub absolute_path: String,
    pub name: String,
    pub status: String,
    /// Lines added/removed in the staged area (HEAD vs index).
    pub staged_insertions: u32,
    pub staged_deletions: u32,
    /// Lines added/removed in the unstaged area (index vs working tree),
    /// including untracked file line counts.
    pub unstaged_insertions: u32,
    pub unstaged_deletions: u32,
    /// Lines added/removed in committed area (target_ref vs HEAD).
    pub committed_insertions: u32,
    pub committed_deletions: u32,
    /// True when git reports the file as binary (`-\t-` in numstat) or when
    /// an untracked file fails UTF-8 decoding. Line counts are 0 for binary
    /// files since they have no meaningful line diff.
    #[serde(skip_serializing_if = "is_false")]
    pub is_binary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staged_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unstaged_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub committed_status: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Total line additions/deletions across a workspace, used by the sidebar
/// row to render the additions/deletions chip. Sums committed (vs target
/// branch), staged, unstaged, and untracked. Computed lazily per workspace
/// via the `get_workspace_diff_stats` command rather than denormalised onto
/// the workspace row — the watcher only sees ref changes (not working-tree
/// edits), so a cached field would force expensive recomputes on every list
/// call.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiffStats {
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFilePrefetchItem {
    pub absolute_path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFilesWithContentResponse {
    pub items: Vec<EditorFileListItem>,
    pub prefetched: Vec<EditorFilePrefetchItem>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct DirEntry {
    pub kind: DirEntryKind,
    pub name: String,
    pub path: String,
    pub absolute_path: String,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum DirEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct PathSearchHit {
    pub kind: DirEntryKind,
    pub name: String,
    pub path: String,
    pub absolute_path: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum EditorFileWriteOutcome {
    Written { path: String, mtime_ms: i64 },
    Conflict { path: String, current_mtime_ms: i64 },
}
