use std::fs;
use tempfile::TempDir;

use helmor_lib::workspace::files::search::{search_paths, MAX_SEARCH_HITS};

fn fixture() -> TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::create_dir_all(root.join("node_modules/lodash")).unwrap();
    fs::create_dir_all(root.join("src/components/forms")).unwrap();
    fs::write(root.join("src/index.ts"), "").unwrap();
    fs::write(root.join("src/components/button.tsx"), "").unwrap();
    fs::write(root.join("src/components/forms/login.tsx"), "").unwrap();
    fs::write(root.join("src/components/forms/signup.tsx"), "").unwrap();
    fs::write(root.join("README.md"), "").unwrap();
    fs::write(root.join("node_modules/lodash/index.js"), "").unwrap();
    tmp
}

#[test]
fn empty_query_returns_no_hits() {
    let tmp = fixture();
    let hits = search_paths(tmp.path().to_str().unwrap(), "").unwrap();
    assert!(hits.is_empty());
}

#[test]
fn substring_query_matches_paths_and_names() {
    let tmp = fixture();
    let hits = search_paths(tmp.path().to_str().unwrap(), "login").unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].name, "login.tsx");
}

#[test]
fn case_insensitive_query() {
    let tmp = fixture();
    let hits = search_paths(tmp.path().to_str().unwrap(), "BUTTON").unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].name, "button.tsx");
}

#[test]
fn skips_dotgit_and_node_modules() {
    let tmp = fixture();
    let hits = search_paths(tmp.path().to_str().unwrap(), "lodash").unwrap();
    assert!(hits.is_empty());
}

#[test]
fn name_prefix_ranks_higher_than_path_match() {
    let tmp = fixture();
    let hits = search_paths(tmp.path().to_str().unwrap(), "sign").unwrap();
    assert_eq!(hits[0].name, "signup.tsx");
}

#[test]
fn results_capped_at_max_hits() {
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir_all(tmp.path().join("dir")).unwrap();
    for i in 0..(MAX_SEARCH_HITS + 50) {
        fs::write(tmp.path().join(format!("dir/file_{i}.ts")), "").unwrap();
    }
    let hits = search_paths(tmp.path().to_str().unwrap(), "file_").unwrap();
    assert_eq!(hits.len(), MAX_SEARCH_HITS);
}
