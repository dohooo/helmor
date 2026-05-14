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
pub struct EditorFileWriteResponse {
    pub path: String,
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
