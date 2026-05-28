//! Context-window budgeting: pick the right `-c` for the active model.
//! Every input (trained max, KV bytes/token) comes from the GGUF
//! header — catalog estimates are deliberately not used, so the panel
//! display and the value llama-server actually allocates can't drift.

use anyhow::{Context, Result};

use super::{catalog, gguf, hardware, settings::load_settings, SETTINGS_KEY};

/// Lower bound for the `-c` slider — going below 4K breaks routing on
/// non-trivial prompts.
pub const MIN_CONTEXT_TOKENS: u32 = 4_096;

const CONTEXT_PRESETS: &[u32] = &[4_096, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144];

/// Pick the runtime `-c` value for `model_path`.
///
/// Both catalog and custom paths take the same route: read the GGUF
/// header, then apply override → hardware-aware default. The only
/// distinction is the settings-map key used for the override (catalog
/// `entry.id` vs `custom:<absolute-path>`). When the GGUF can't be read
/// (file not downloaded, corrupt header, unsupported version) we return
/// the safe fallback constant so the caller can keep degraded service.
pub(super) fn resolve_context_for_path(model_path: &str) -> u32 {
    if model_path.trim().is_empty() {
        return catalog::FALLBACK_CONTEXT_TOKENS;
    }
    let settings = load_settings();
    let total_ram_gb = hardware::detect().total_ram_gb;
    let path = std::path::Path::new(model_path);
    let meta = match gguf::read_metadata(path) {
        Ok(meta) => meta,
        Err(error) => {
            tracing::debug!(
                model_path,
                error = %error,
                "GGUF metadata read failed; falling back to {}",
                catalog::FALLBACK_CONTEXT_TOKENS,
            );
            return catalog::FALLBACK_CONTEXT_TOKENS;
        }
    };
    let override_key = override_key_for_path(model_path);
    if let Some(&override_value) = settings.context_overrides.get(&override_key) {
        return override_value.clamp(MIN_CONTEXT_TOKENS, meta.context_length);
    }
    compute_default_context_for_meta(&meta, total_ram_gb)
}

/// Settings-map key for `context_overrides` entries on user-supplied
/// GGUFs. Prefixed so it can't collide with a catalog id.
pub fn custom_override_key(path: &str) -> String {
    format!("custom:{path}")
}

/// Choose the override key for a model path: catalog `entry.id` when
/// the path lives under our `local-llm/models/` cache, else `custom:<path>`.
fn override_key_for_path(model_path: &str) -> String {
    for entry in catalog::catalog() {
        if let Some(first) = entry.files.first() {
            let expected_suffix = format!("local-llm/models/{first}");
            if model_path.ends_with(&expected_suffix) {
                return entry.id;
            }
        }
    }
    custom_override_key(model_path)
}

/// Hardware-aware default `-c` driven by GGUF metadata. Picks the
/// largest preset (powers of 2 from 4K to 256K) that:
///   - stays under the model's trained context window
///   - fits inside `(total_ram − os_reserve)` after the KV cache cost
///
/// `os_reserve` is `min(8 GB, total_ram × 10 %)`. Model-weight
/// footprint isn't subtracted — the GGUF header doesn't carry it and
/// `llama-server` caps its own allocation, so over-budgeting here just
/// means the chosen preset gets clamped at startup, not OOMs.
pub fn compute_default_context_for_meta(meta: &gguf::ModelMetadata, total_ram_gb: u8) -> u32 {
    pick_best_preset(total_ram_gb, meta.kv_bytes_per_token(), meta.context_length)
}

fn pick_best_preset(
    total_ram_gb: u8,
    kv_bytes_per_token: u32,
    model_max_context_tokens: u32,
) -> u32 {
    if total_ram_gb == 0 {
        return MIN_CONTEXT_TOKENS;
    }
    let total = u64::from(total_ram_gb) * 1_073_741_824;
    let os_reserve = (8u64 * 1_073_741_824).min(((total as f64) * 0.10) as u64);
    let available = total.saturating_sub(os_reserve);
    let kv_per = u64::from(kv_bytes_per_token).max(1);
    let max_tokens = (available / kv_per) as u32;
    let mut best = MIN_CONTEXT_TOKENS;
    for &preset in CONTEXT_PRESETS {
        if preset > model_max_context_tokens {
            break;
        }
        if preset > max_tokens {
            break;
        }
        best = preset;
    }
    best
}

/// Write a per-entry context override (or remove it when `value`
/// matches the hardware-aware default — keeps settings tidy and lets
/// the default re-evaluate if the user upgrades their Mac).
///
/// Both catalog entries and custom paths route through the GGUF
/// metadata — the panel only renders the slider once inspect has
/// succeeded, so by the time this is called we're guaranteed to have a
/// real file to read.
pub fn set_context_override(entry_id: &str, value: u32) -> Result<()> {
    let path = if let Some(custom_path) = entry_id.strip_prefix("custom:") {
        std::path::PathBuf::from(custom_path)
    } else {
        let entry = catalog::catalog()
            .into_iter()
            .find(|e| e.id == entry_id)
            .with_context(|| format!("unknown catalog entry: {entry_id}"))?;
        let first_file = entry.files.first().context("catalog entry has no files")?;
        crate::data_dir::local_llm_models_dir()?.join(first_file)
    };
    let meta = gguf::read_metadata(&path)
        .with_context(|| format!("read GGUF metadata for override target: {}", path.display()))?;
    let clamped = value.clamp(MIN_CONTEXT_TOKENS, meta.context_length);
    let default = compute_default_context_for_meta(&meta, hardware::detect().total_ram_gb);

    let mut settings = load_settings();
    if clamped == default {
        settings.context_overrides.remove(entry_id);
    } else {
        settings
            .context_overrides
            .insert(entry_id.to_string(), clamped);
    }
    crate::settings::upsert_setting_json(SETTINGS_KEY, &settings)
        .context("persist Local LLM context override")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic GGUF metadata that yields exactly
    /// `kv_bytes_per_token` from the formula
    /// `4 × kv_heads × head_dim × layers`. Holding kv_heads / head_count /
    /// block_count at 1 leaves `embedding_length = kv_bytes_per_token / 4`.
    fn meta(context_length: u32, kv_bytes_per_token: u32) -> gguf::ModelMetadata {
        gguf::ModelMetadata {
            architecture: "test".into(),
            name: None,
            context_length,
            block_count: 1,
            embedding_length: kv_bytes_per_token / 4,
            head_count: 1,
            kv_head_count: 1,
        }
    }

    #[test]
    fn picks_largest_preset_within_model_max_and_ram() {
        // 64 KB/token at 16 GB → reserve = 1.6 GB → 14.4 GB / 64 KB ≈
        // 235K tokens; clamps to model_max 128K.
        let m = meta(131_072, 65_536);
        assert_eq!(compute_default_context_for_meta(&m, 16), 131_072);
    }

    #[test]
    fn scales_down_when_kv_eats_ram() {
        // 256 KB/token at 32 GB → reserve = 3.2 GB → 28.8 GB / 256 KB ≈
        // 117K → next preset down = 64K.
        let m = meta(262_144, 262_144);
        assert_eq!(compute_default_context_for_meta(&m, 32), 65_536);
    }

    #[test]
    fn returns_min_when_kv_too_expensive_for_host() {
        // 4 MB/token at 16 GB → max_tokens ≈ 3.6K, below the 4K floor.
        let m = meta(262_144, 4_194_304);
        assert_eq!(compute_default_context_for_meta(&m, 16), MIN_CONTEXT_TOKENS);
    }

    #[test]
    fn returns_min_on_unknown_hardware() {
        let m = meta(131_072, 65_536);
        assert_eq!(compute_default_context_for_meta(&m, 0), MIN_CONTEXT_TOKENS);
    }

    #[test]
    fn huge_macs_reach_model_max() {
        let m = meta(262_144, 65_536);
        assert_eq!(compute_default_context_for_meta(&m, 255), 262_144);
    }
}
