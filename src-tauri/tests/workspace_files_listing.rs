use std::fs;
use tempfile::TempDir;

use helmor_lib::workspace::files::listing::list_directory;

fn workspace_with_files() -> TempDir {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::create_dir_all(root.join("src/components")).unwrap();
    fs::create_dir_all(root.join("node_modules/foo")).unwrap();
    fs::write(root.join("README.md"), "hi").unwrap();
    fs::write(root.join("src/index.ts"), "export {};").unwrap();
    fs::write(root.join("src/components/button.tsx"), "export {};").unwrap();
    tmp
}

#[test]
fn list_root_returns_top_level_entries_sorted() {
    let tmp = workspace_with_files();
    let entries = list_directory(tmp.path().to_str().unwrap(), "").expect("list");
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["src", "README.md"]);
}

#[test]
fn list_skips_dotgit_and_node_modules_at_top_level() {
    let tmp = workspace_with_files();
    let entries = list_directory(tmp.path().to_str().unwrap(), "").expect("list");
    assert!(entries.iter().all(|e| e.name != ".git"));
    assert!(entries.iter().all(|e| e.name != "node_modules"));
}

#[test]
fn list_subdirectory_returns_its_children() {
    let tmp = workspace_with_files();
    let entries = list_directory(tmp.path().to_str().unwrap(), "src").expect("list");
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["components", "index.ts"]);
}

#[test]
fn list_rejects_parent_traversal() {
    let tmp = workspace_with_files();
    let err = list_directory(tmp.path().to_str().unwrap(), "../etc").unwrap_err();
    assert!(err.to_string().to_lowercase().contains("traversal"));
}

#[test]
fn list_rejects_absolute_relative_path() {
    let tmp = workspace_with_files();
    let err = list_directory(tmp.path().to_str().unwrap(), "/etc").unwrap_err();
    assert!(err.to_string().to_lowercase().contains("absolute"));
}

#[test]
fn list_missing_workspace_errors() {
    let err = list_directory("/definitely/does/not/exist", "").unwrap_err();
    assert!(err.to_string().to_lowercase().contains("workspace"));
}
