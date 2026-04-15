//! Slash command cache.
//!
//! Stores the last successful full result (from the
//!    sidecar/SDK) per `(provider, cwd, model)` key so subsequent `/` presses
//!    resolve instantly.

use std::collections::HashMap;
use std::sync::{Mutex, RwLock};

use super::queries::SlashCommandEntry;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type CacheKey = (String, String, String); // (provider, cwd, model)

pub fn cache_key(
    provider: &str,
    working_directory: Option<&str>,
    _model_id: Option<&str>,
) -> CacheKey {
    (
        provider.to_string(),
        working_directory.unwrap_or_default().to_string(),
        String::new(),
    )
}

struct CachedResult {
    commands: Vec<SlashCommandEntry>,
    is_complete: bool,
}

pub struct SlashCommandCache {
    entries: RwLock<HashMap<CacheKey, CachedResult>>,
    /// Prevents duplicate background refreshes for the same cache key while
    /// still allowing different workspaces/providers to refresh concurrently.
    refreshing: Mutex<std::collections::HashSet<CacheKey>>,
}

impl Default for SlashCommandCache {
    fn default() -> Self {
        Self::new()
    }
}

impl SlashCommandCache {
    pub fn new() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            refreshing: Mutex::new(std::collections::HashSet::new()),
        }
    }

    pub fn get(&self, key: &CacheKey) -> Option<(Vec<SlashCommandEntry>, bool)> {
        let map = self.entries.read().ok()?;
        if let Some(cached) = map.get(key) {
            tracing::debug!(
                provider = %key.0,
                cwd = %key.1,
                model = %key.2,
                count = cached.commands.len(),
                is_complete = cached.is_complete,
                "Slash-command cache exact hit"
            );
            return Some((cached.commands.clone(), cached.is_complete));
        }

        tracing::debug!(
            provider = %key.0,
            cwd = %key.1,
            model = %key.2,
            "Slash-command cache miss"
        );
        None
    }

    pub fn set(&self, key: CacheKey, commands: Vec<SlashCommandEntry>, is_complete: bool) {
        if let Ok(mut map) = self.entries.write() {
            map.insert(
                key,
                CachedResult {
                    commands,
                    is_complete,
                },
            );
        }
    }

    /// Try to claim the refresh lock for a single cache key. Returns `true`
    /// if this caller won.
    pub fn try_start_refresh(&self, key: &CacheKey) -> bool {
        let Ok(mut refreshing) = self.refreshing.lock() else {
            return false;
        };
        refreshing.insert(key.clone())
    }

    pub fn finish_refresh(&self, key: &CacheKey) {
        if let Ok(mut refreshing) = self.refreshing.lock() {
            refreshing.remove(key);
        }
    }
}

// ---------------------------------------------------------------------------
// Local skill/command scanner
