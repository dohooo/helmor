mod changes;
mod editor;
mod search;
mod support;
mod types;
mod watcher;

pub use changes::{
    discard_workspace_file, discard_workspace_file_inner, list_workspace_changes,
    list_workspace_changes_for_workspace, list_workspace_changes_with_content, stage_workspace_file,
    stage_workspace_file_inner, unstage_workspace_file, unstage_workspace_file_inner,
};
pub use editor::{
    list_editor_files, list_editor_files_inner, list_editor_files_with_content,
    list_workspace_files, list_workspace_files_inner, read_editor_file, read_editor_file_inner,
    read_file_at_ref, stat_editor_file, stat_editor_file_inner, write_editor_file,
    write_editor_file_inner,
};
pub use search::{search_workspace_inner, SearchHit, SearchResults};
pub use types::{
    EditorFileListItem, EditorFilePrefetchItem, EditorFileReadResponse, EditorFileStatResponse,
    EditorFileWriteResponse, EditorFilesWithContentResponse,
};
pub use watcher::{FileChange, FileChangeKind, FileWatcher, DEFAULT_DEBOUNCE};

#[cfg(test)]
mod tests;
