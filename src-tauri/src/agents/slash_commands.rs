//! Slash-command cache.
//!
//! Two-tier cache:
//! 1. **Workspace tier** — keyed by `(provider, cwd)`. Primary cache — an exact
//!    hit returns instantly and we revalidate in the background.
//! 2. **Repo tier** — keyed by `(provider, repo_id)`. Fallback used when the
//!    workspace tier misses. Different workspaces on the same repo usually
//!    share the same `~/.claude/skills/` and `.claude/commands/`, so we can
//!    show stale-but-plausible commands while the real scan runs.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, RwLock};

use super::queries::SlashCommandEntry;

pub type WorkspaceKey = (String, String); // (provider, cwd)
pub type RepoKey = (String, String); // (provider, repo_id)

pub fn workspace_key(provider: &str, working_directory: Option<&str>) -> WorkspaceKey {
    (
        provider.to_string(),
        working_directory.unwrap_or_default().to_string(),
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

// ---------------------------------------------------------------------------
// Local skill/command scanner
