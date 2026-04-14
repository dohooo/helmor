use std::env;
use std::path::{Path, PathBuf};

const GITHUB_CLIENT_ID_KEY: &str = "HELMOR_GITHUB_CLIENT_ID";
const GITHUB_CLIENT_SECRET_KEY: &str = "HELMOR_GITHUB_CLIENT_SECRET";

fn main() {
    tauri_build::build();

    println!("cargo:rerun-if-changed=build.rs");

    for env_path in candidate_env_paths() {
        // Only watch files that exist. Watching a missing file makes Cargo
        // treat the fingerprint as permanently stale, which forces a full
        // recompile of the crate on every single `cargo build` invocation.
        if env_path.exists() {
            println!("cargo:rerun-if-changed={}", env_path.display());
        }
        load_env_var(&env_path, GITHUB_CLIENT_ID_KEY);
        load_env_var(&env_path, GITHUB_CLIENT_SECRET_KEY);
    }
}

fn candidate_env_paths() -> Vec<PathBuf> {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"));
    let mut paths = vec![manifest_dir.join(".env.local")];

    if let Some(repo_root) = manifest_dir.parent() {
        paths.push(repo_root.join(".env.local"));
    }

    paths
}

fn load_env_var(path: &Path, key: &str) {
    if env::var_os(key).is_some() || !path.exists() {
        return;
    }

    let Ok(iter) = dotenvy::from_path_iter(path) else {
        return;
    };

    for item in iter.flatten() {
        if item.0 == key {
            println!("cargo:rustc-env={}={}", item.0, item.1);
            break;
        }
    }
}
