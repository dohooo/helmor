//! Curated LLM catalog driving the Local LLM settings panel. The
//! downloads manager (via `CatalogAssetProvider`) reads this list to
//! know what to fetch / verify; the panel renders the entries as a
//! dropdown of pickable Qwen variants.
//!
//! Adding an entry = append to `catalog()`. The unit tests in this
//! file enforce uniqueness + RAM-tier ordering so accidental catalog
//! regressions surface in CI without a snapshot review.

use serde::{Deserialize, Serialize};

/// Fallback context window used when the running model is NOT a
/// catalog entry (e.g. user pasted a custom `.gguf` path). 32K is a
/// reasonable common-denominator — covers title generation, commit
/// drafts, summaries without blowing the KV cache.
pub const FALLBACK_CONTEXT_TOKENS: u32 = 32_768;

/// Which subsystem owns this entry. Currently only LLM; kept as an
/// enum so future entry kinds can be added without churning every
/// catalog row.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    /// Chat brain. Loaded by `local_llm::Manager` (llama-server).
    #[default]
    Llm,
}

/// One row in the curated model catalog the panel renders. HF GGUFs:
/// the worker resolves `https://huggingface.co/{repo}/resolve/main/{file}`
/// and fetches the HF manifest for per-file SHA-256 + sizes. KV cache
/// shape and trained context window are deliberately NOT in here —
/// those numbers are read from the GGUF header after download so the
/// panel can't drift from what llama-server actually allocates.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub repo: String,
    /// Every GGUF file the model spans (multi-part shards listed in
    /// load order; single-file models list one entry).
    pub files: Vec<String>,
    pub label: String,
    pub quant: String,
    pub bytes: u64,
    pub min_ram_gb: u8,
    pub recommended_for_gb: u8,
    pub blurb: String,
    /// Which subsystem this entry belongs to. Defaults to LLM so
    /// existing entries don't need touching.
    #[serde(default)]
    pub kind: ModelKind,
    /// Vision projector GGUF (multimodal). When set, downloads alongside
    /// the main weights and llama-server starts with `--mmproj`.
    #[serde(default)]
    pub mmproj_file: Option<String>,
    /// Bytes of the mmproj file; folded into `total_bytes()` for the UI.
    #[serde(default)]
    pub mmproj_bytes: u64,
}

impl CatalogEntry {
    /// Main weights + mmproj (the footprint the UI should show).
    pub fn total_bytes(&self) -> u64 {
        self.bytes + self.mmproj_bytes
    }
}

/// Curated catalog. Sorted by `recommended_for_gb` ascending. Every Qwen
/// 3.5+ row also pulls the F16 mmproj from the same repo so llama-server
/// boots with vision enabled.
pub fn catalog() -> Vec<CatalogEntry> {
    vec![
        CatalogEntry {
            id: "qwen35-4b-q4".into(),
            repo: "unsloth/Qwen3.5-4B-GGUF".into(),
            files: vec!["Qwen3.5-4B-Q4_K_M.gguf".into()],
            label: "Qwen3.5 4B".into(),
            quant: "Q4_K_M".into(),
            bytes: 2_500_000_000,
            min_ram_gb: 8,
            recommended_for_gb: 16,
            blurb: "Compact starter — chat, simple drafts, image input.".into(),
            kind: ModelKind::Llm,
            mmproj_file: Some("mmproj-F16.gguf".into()),
            mmproj_bytes: 672_423_616,
        },
        CatalogEntry {
            id: "qwen35-9b-q4".into(),
            repo: "unsloth/Qwen3.5-9B-GGUF".into(),
            files: vec!["Qwen3.5-9B-Q4_K_M.gguf".into()],
            label: "Qwen3.5 9B".into(),
            quant: "Q4_K_M".into(),
            bytes: 5_400_000_000,
            min_ram_gb: 12,
            recommended_for_gb: 24,
            blurb: "All-rounder with vision. Comfortable on 24 GB Macs.".into(),
            kind: ModelKind::Llm,
            mmproj_file: Some("mmproj-F16.gguf".into()),
            mmproj_bytes: 918_166_080,
        },
        CatalogEntry {
            id: "qwen36-27b-q4".into(),
            repo: "unsloth/Qwen3.6-27B-GGUF".into(),
            files: vec!["Qwen3.6-27B-Q4_K_M.gguf".into()],
            label: "Qwen3.6 27B".into(),
            quant: "Q4_K_M".into(),
            bytes: 16_200_000_000,
            min_ram_gb: 20,
            recommended_for_gb: 32,
            blurb: "Dense flagship with vision — solid 32 GB pick.".into(),
            kind: ModelKind::Llm,
            mmproj_file: Some("mmproj-F16.gguf".into()),
            mmproj_bytes: 927_607_360,
        },
        CatalogEntry {
            id: "qwen36-35b-a3b-q4".into(),
            repo: "unsloth/Qwen3.6-35B-A3B-GGUF".into(),
            files: vec!["Qwen3.6-35B-A3B-UD-Q4_K_M.gguf".into()],
            label: "Qwen3.6 35B-A3B".into(),
            quant: "Q4_K_M".into(),
            bytes: 21_000_000_000,
            min_ram_gb: 24,
            recommended_for_gb: 32,
            blurb: "Sparse MoE with vision — 35B params, ~3B active.".into(),
            kind: ModelKind::Llm,
            mmproj_file: Some("mmproj-F16.gguf".into()),
            mmproj_bytes: 899_283_680,
        },
        CatalogEntry {
            id: "qwen36-35b-a3b-q8".into(),
            repo: "unsloth/Qwen3.6-35B-A3B-GGUF".into(),
            files: vec!["Qwen3.6-35B-A3B-Q8_0.gguf".into()],
            label: "Qwen3.6 35B-A3B".into(),
            quant: "Q8_0".into(),
            bytes: 37_000_000_000,
            min_ram_gb: 40,
            recommended_for_gb: 48,
            blurb: "Sweet spot with vision. The 48-GB default.".into(),
            kind: ModelKind::Llm,
            mmproj_file: Some("mmproj-F16.gguf".into()),
            mmproj_bytes: 899_283_680,
        },
        CatalogEntry {
            id: "qwen35-122b-a10b-q4".into(),
            repo: "unsloth/Qwen3.5-122B-A10B-GGUF".into(),
            files: vec![
                "Qwen3.5-122B-A10B-Q4_K_M-00001-of-00003.gguf".into(),
                "Qwen3.5-122B-A10B-Q4_K_M-00002-of-00003.gguf".into(),
                "Qwen3.5-122B-A10B-Q4_K_M-00003-of-00003.gguf".into(),
            ],
            label: "Qwen3.5 122B-A10B".into(),
            quant: "Q4_K_M".into(),
            bytes: 73_000_000_000,
            min_ram_gb: 80,
            recommended_for_gb: 96,
            blurb: "Frontier MoE with vision — 122B params, ~10B active.".into(),
            kind: ModelKind::Llm,
            mmproj_file: Some("mmproj-F16.gguf".into()),
            mmproj_bytes: 908_724_960,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalog_ids_are_unique() {
        let entries = catalog();
        let mut seen = HashSet::new();
        for entry in &entries {
            assert!(
                seen.insert(entry.id.clone()),
                "duplicate catalog id: {}",
                entry.id
            );
        }
    }

    #[test]
    fn catalog_is_non_empty_and_sorted_by_recommended_ram() {
        let entries = catalog();
        assert!(!entries.is_empty(), "catalog must not be empty");
        for window in entries.windows(2) {
            assert!(
                window[0].recommended_for_gb <= window[1].recommended_for_gb,
                "catalog must be ordered by recommended_for_gb (asc): {} ({}) then {} ({})",
                window[0].id,
                window[0].recommended_for_gb,
                window[1].id,
                window[1].recommended_for_gb,
            );
        }
    }

    #[test]
    fn min_ram_never_exceeds_recommended_ram() {
        for entry in catalog() {
            assert!(
                entry.min_ram_gb <= entry.recommended_for_gb,
                "{}: min_ram_gb ({}) > recommended_for_gb ({})",
                entry.id,
                entry.min_ram_gb,
                entry.recommended_for_gb,
            );
        }
    }

    #[test]
    fn every_entry_has_at_least_one_file() {
        for entry in catalog() {
            assert!(
                !entry.files.is_empty(),
                "{}: files vector is empty — every catalog entry must list at least one artefact",
                entry.id
            );
        }
    }
}
