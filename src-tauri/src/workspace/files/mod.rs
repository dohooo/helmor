mod changes;
pub mod editor;
pub mod listing;
pub mod search;
mod support;
pub mod types;

pub use changes::{
    compute_workspace_diff_stats, discard_workspace_file, list_workspace_changes,
    list_workspace_changes_with_content, stage_workspace_file, unstage_workspace_file,
};
pub use editor::{
    create_workspace_file, create_workspace_folder, list_editor_files,
    list_editor_files_with_content, list_workspace_files, read_editor_file, read_file_at_ref,
    stat_editor_file, write_editor_file, CreateEntryResponse, EditorFileWriteOptions,
};
pub use types::{
    DirEntry, DirEntryKind, EditorFileListItem, EditorFilePrefetchItem, EditorFileReadResponse,
    EditorFileStatResponse, EditorFileWriteOutcome, EditorFilesWithContentResponse, PathSearchHit,
    WorkspaceDiffStats,
};

#[cfg(test)]
mod tests;
