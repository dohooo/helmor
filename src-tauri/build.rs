use std::env;
use std::path::{Path, PathBuf};

const GITHUB_CLIENT_ID_KEY: &str = "HELMOR_GITHUB_CLIENT_ID";

fn main() {
    tauri_build::build();

    println!("cargo:rerun-if-changed=build.rs");

    for env_path in candidate_env_paths() {
        println!("cargo:rerun-if-changed={}", env_path.display());
        load_github_client_id(&env_path);
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

fn load_github_client_id(path: &Path) {
    if env::var_os(GITHUB_CLIENT_ID_KEY).is_some() || !path.exists() {
        return;
    }

    let Ok(iter) = dotenvy::from_path_iter(path) else {
        return;
    };

    for item in iter.flatten() {
        if item.0 == GITHUB_CLIENT_ID_KEY {
            println!("cargo:rustc-env={}={}", item.0, item.1);
            break;
        }
    }
}
