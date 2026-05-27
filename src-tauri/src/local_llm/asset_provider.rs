//! Bridge between the LLM catalog and the generic `DownloadsManager`.
//! Translates each `CatalogEntry` into an `Asset` so the downloads
//! module never sees domain concepts.

use crate::downloads::{ArchiveKind, Asset, AssetProvider, AssetSource, OptionalFile};
use crate::local_llm::catalog::{self, CatalogEntry};

/// `AssetProvider` for every entry in `local_llm::catalog`. Stateless —
/// the catalog is compile-time const, so re-deriving on every call is
/// cheap and lets newly-added entries flow through without restart.
pub struct CatalogAssetProvider;

impl AssetProvider for CatalogAssetProvider {
    fn assets(&self) -> Vec<Asset> {
        let Ok(target_dir) = crate::data_dir::local_llm_models_dir() else {
            tracing::warn!("local_llm_models_dir() failed; download manager has no assets");
            return Vec::new();
        };
        catalog::catalog()
            .into_iter()
            .map(|entry| catalog_entry_to_asset(entry, &target_dir))
            .collect()
    }
}

fn catalog_entry_to_asset(entry: CatalogEntry, target_dir: &std::path::Path) -> Asset {
    let estimated_bytes = entry.total_bytes();
    // mmproj is optional: missing projector doesn't demote an install.
    // Per-repo suffix prevents collisions across Qwen variants.
    let optional_files: Vec<OptionalFile> = entry
        .mmproj_file
        .into_iter()
        .map(|remote| OptionalFile {
            local_name: mmproj_local_name(&remote, &entry.repo),
            remote_name: remote,
        })
        .collect();
    Asset {
        id: entry.id,
        target_dir: target_dir.to_path_buf(),
        files: entry.files,
        optional_files,
        source: AssetSource::HuggingFace { repo: entry.repo },
        archive: ArchiveKind::None,
        is_directory: false,
        estimated_bytes,
    }
}

/// e.g. `mmproj-F16.gguf` + `unsloth/Qwen3.6-27B-GGUF` → `mmproj-F16.unsloth_Qwen3.6-27B-GGUF.gguf`.
pub fn mmproj_local_name(remote_name: &str, repo: &str) -> String {
    let (stem, ext) = match remote_name.rsplit_once('.') {
        Some((s, e)) => (s, e),
        None => (remote_name, "gguf"),
    };
    let suffix: String = repo
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | ' ' => '_',
            c if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') => c,
            _ => '_',
        })
        .collect();
    format!("{stem}.{suffix}.{ext}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_repo_suffix_disambiguates_collisions() {
        let a = mmproj_local_name("mmproj-F16.gguf", "unsloth/Qwen3.5-9B-GGUF");
        let b = mmproj_local_name("mmproj-F16.gguf", "unsloth/Qwen3.6-27B-GGUF");
        assert_ne!(a, b);
        assert_eq!(a, "mmproj-F16.unsloth_Qwen3.5-9B-GGUF.gguf");
        assert_eq!(b, "mmproj-F16.unsloth_Qwen3.6-27B-GGUF.gguf");
    }

    #[test]
    fn same_repo_yields_same_local_name() {
        // q4 + q8 entries of the same Qwen variant must share a single
        // mmproj on disk — otherwise the user pays ~900 MB twice.
        let q4 = mmproj_local_name("mmproj-F16.gguf", "unsloth/Qwen3.6-35B-A3B-GGUF");
        let q8 = mmproj_local_name("mmproj-F16.gguf", "unsloth/Qwen3.6-35B-A3B-GGUF");
        assert_eq!(q4, q8);
    }
}
