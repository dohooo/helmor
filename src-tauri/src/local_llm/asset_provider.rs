//! Bridge between the LLM catalog and the generic `DownloadsManager`.
//! Translates each `CatalogEntry` into an `Asset` so the downloads
//! module never sees domain concepts.

use crate::downloads::{ArchiveKind, Asset, AssetProvider, AssetSource};
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
    // mmproj is optional: an existing main-weights-only install stays
    // "Downloaded" instead of regressing to "Paused", and a missing/404
    // mmproj on a fresh fetch still yields a usable text-only model.
    let optional_files = entry.mmproj_file.into_iter().collect();
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
