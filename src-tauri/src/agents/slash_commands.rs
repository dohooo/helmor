//! Slash-command cache.
//!
//! Two-tier cache:
//! 1. **Workspace tier** — keyed by `(provider, cwd, linked-dir-signature)`.
//!    Primary cache — an exact hit returns instantly and we revalidate in the
//!    background.
//! 2. **Repo tier** — keyed by `(provider, repo_id)`. Fallback used when the
//!    workspace tier misses. Different workspaces on the same repo usually
//!    share the same `~/.claude/skills/` and `.claude/commands/`, so we can
//!    show stale-but-plausible commands while the real scan runs.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, RwLock};

use super::queries::SlashCommandEntry;

pub type WorkspaceKey = (String, String, String); // (provider, cwd, linked-dir-signature)
pub type RepoKey = (String, String); // (provider, repo_id)

pub fn workspace_key(
    provider: &str,
    working_directory: Option<&str>,
    additional_directories: &[String],
) -> WorkspaceKey {
    (
        provider.to_string(),
        working_directory.unwrap_or_default().to_string(),
        additional_directories.join("\u{1f}"),
    )
}

pub fn repo_key(provider: &str, repo_id: &str) -> RepoKey {
    (provider.to_string(), repo_id.to_string())
}

pub struct SlashCommandCache {
    workspaces: RwLock<HashMap<WorkspaceKey, Vec<SlashCommandEntry>>>,
    repos: RwLock<HashMap<RepoKey, Vec<SlashCommandEntry>>>,
    /// Prevents duplicate background refreshes for the same workspace key.
    refreshing: Mutex<HashSet<WorkspaceKey>>,
}

impl Default for SlashCommandCache {
    fn default() -> Self {
        Self::new()
    }
}

impl SlashCommandCache {
    pub fn new() -> Self {
        Self {
            workspaces: RwLock::new(HashMap::new()),
            repos: RwLock::new(HashMap::new()),
            refreshing: Mutex::new(HashSet::new()),
        }
    }

    /// Exact workspace-level lookup.
    pub fn get_workspace(&self, key: &WorkspaceKey) -> Option<Vec<SlashCommandEntry>> {
        let map = self.workspaces.read().ok()?;
        let commands = map.get(key)?.clone();
        tracing::debug!(
            provider = %key.0,
            cwd = %key.1,
            linked_dir_count = key.2.split('\u{1f}').filter(|s| !s.is_empty()).count(),
            count = commands.len(),
            "Slash-command workspace cache hit"
        );
        Some(commands)
    }

    /// Repo-level fallback lookup — used only when the workspace tier misses.
    pub fn get_repo(&self, key: &RepoKey) -> Option<Vec<SlashCommandEntry>> {
        let map = self.repos.read().ok()?;
        let commands = map.get(key)?.clone();
        tracing::debug!(
            provider = %key.0,
            repo_id = %key.1,
            count = commands.len(),
            "Slash-command repo-level fallback hit"
        );
        Some(commands)
    }

    /// Write a result into the workspace tier, and also mirror it to the repo
    /// tier (latest-wins) so future workspaces on the same repo get a good
    /// fallback on first access.
    pub fn set(
        &self,
        workspace_key: WorkspaceKey,
        repo_id: Option<&str>,
        commands: Vec<SlashCommandEntry>,
    ) {
        if let Ok(mut map) = self.workspaces.write() {
            map.insert(workspace_key.clone(), commands.clone());
        }
        if let Some(repo_id) = repo_id.filter(|id| !id.is_empty()) {
            let rkey = repo_key(&workspace_key.0, repo_id);
            if let Ok(mut map) = self.repos.write() {
                map.insert(rkey, commands);
            }
        }
    }

    /// Try to claim the refresh lock for a workspace key. Returns `true` if
    /// this caller won.
    pub fn try_start_refresh(&self, key: &WorkspaceKey) -> bool {
        let Ok(mut refreshing) = self.refreshing.lock() else {
            return false;
        };
        refreshing.insert(key.clone())
    }

    pub fn finish_refresh(&self, key: &WorkspaceKey) {
        if let Ok(mut refreshing) = self.refreshing.lock() {
            refreshing.remove(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str) -> SlashCommandEntry {
        SlashCommandEntry {
            name: name.to_string(),
            description: format!("desc for {name}"),
            argument_hint: None,
            source: "skill".to_string(),
        }
    }

    #[test]
    fn workspace_key_distinguishes_provider() {
        let claude = workspace_key("claude", Some("/repo"), &["/linked".to_string()]);
        let codex = workspace_key("codex", Some("/repo"), &["/linked".to_string()]);
        assert_ne!(claude, codex);
    }

    #[test]
    fn workspace_key_distinguishes_linked_dir_signature() {
        let none = workspace_key("claude", Some("/repo"), &[]);
        let one = workspace_key("claude", Some("/repo"), &["/linked".to_string()]);
        let two = workspace_key(
            "claude",
            Some("/repo"),
            &["/linked".to_string(), "/other".to_string()],
        );
        assert_ne!(none, one);
        assert_ne!(one, two);
    }

    #[test]
    fn workspace_key_treats_none_cwd_as_empty_string() {
        let none = workspace_key("claude", None, &[]);
        let empty = workspace_key("claude", Some(""), &[]);
        assert_eq!(none, empty);
    }

    #[test]
    fn cache_starts_empty_and_returns_none() {
        let cache = SlashCommandCache::new();
        let key = workspace_key("claude", Some("/repo"), &[]);
        assert!(cache.get_workspace(&key).is_none());
        assert!(cache
            .get_repo(&("claude".into(), "repo-1".into()))
            .is_none());
    }

    #[test]
    fn set_writes_workspace_and_mirrors_repo_when_repo_id_present() {
        let cache = SlashCommandCache::new();
        let key = workspace_key("claude", Some("/repo"), &[]);
        cache.set(key.clone(), Some("repo-1"), vec![entry("a"), entry("b")]);

        assert_eq!(cache.get_workspace(&key).unwrap().len(), 2);
        let repo_hit = cache.get_repo(&repo_key("claude", "repo-1")).unwrap();
        assert_eq!(repo_hit.len(), 2);
        assert_eq!(repo_hit[0].name, "a");
    }

    #[test]
    fn set_skips_repo_mirror_when_repo_id_is_empty_or_missing() {
        let cache = SlashCommandCache::new();
        let key = workspace_key("claude", Some("/repo"), &[]);
        cache.set(key.clone(), None, vec![entry("a")]);
        cache.set(key.clone(), Some(""), vec![entry("a")]);

        // Workspace tier was written.
        assert!(cache.get_workspace(&key).is_some());
        // Repo tier was not — the empty repo_id falls in the same bucket as None.
        assert!(cache.get_repo(&repo_key("claude", "")).is_none());
    }

    #[test]
    fn try_start_refresh_is_exclusive_until_finish() {
        let cache = SlashCommandCache::new();
        let key = workspace_key("claude", Some("/repo"), &[]);

        assert!(cache.try_start_refresh(&key), "first call wins the lock");
        assert!(!cache.try_start_refresh(&key), "second call loses");

        cache.finish_refresh(&key);
        assert!(
            cache.try_start_refresh(&key),
            "after finish, the lock can be reclaimed"
        );
    }

    #[test]
    fn try_start_refresh_independent_keys_dont_block_each_other() {
        let cache = SlashCommandCache::new();
        let a = workspace_key("claude", Some("/a"), &[]);
        let b = workspace_key("claude", Some("/b"), &[]);
        assert!(cache.try_start_refresh(&a));
        assert!(cache.try_start_refresh(&b));
    }

    #[test]
    fn finish_refresh_on_unheld_key_is_a_noop() {
        let cache = SlashCommandCache::new();
        let key = workspace_key("claude", Some("/repo"), &[]);
        cache.finish_refresh(&key);
        // Subsequent claim still works.
        assert!(cache.try_start_refresh(&key));
    }

    #[test]
    fn cache_set_overwrites_previous_value_for_same_key() {
        let cache = SlashCommandCache::new();
        let key = workspace_key("claude", Some("/repo"), &[]);
        cache.set(key.clone(), Some("repo-1"), vec![entry("old")]);
        cache.set(
            key.clone(),
            Some("repo-1"),
            vec![entry("new"), entry("two")],
        );

        let entries = cache.get_workspace(&key).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "new");
    }

    #[test]
    fn cache_concurrent_get_and_set_does_not_panic() {
        use std::sync::Arc;
        use std::thread;

        let cache = Arc::new(SlashCommandCache::new());
        let key = workspace_key("claude", Some("/repo"), &[]);
        cache.set(key.clone(), Some("repo-1"), vec![entry("init")]);

        let mut handles = Vec::new();
        for i in 0..8 {
            let cache = cache.clone();
            let key = key.clone();
            handles.push(thread::spawn(move || {
                if i % 2 == 0 {
                    let _ = cache.get_workspace(&key);
                } else {
                    cache.set(key.clone(), Some("repo-1"), vec![entry(&format!("e{i}"))]);
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert!(cache.get_workspace(&key).is_some());
    }
}

// ---------------------------------------------------------------------------
// Local skill/command scanner
