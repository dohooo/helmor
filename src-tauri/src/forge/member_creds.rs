//! Per-member forge credentials available to the running serve host.
//!
//! Team mode injects EVERY member's gh/glab creds into the shared container; this
//! store holds them keyed by member id. The forge layer reads the
//! [`acting_member`](super::acting_member) and looks up the matching token to run
//! gh/glab AS that member (true per-member).
//!
//! Source of truth = a JSON file at `$HELMOR_FORGE_MEMBERS_PATH` (written by the
//! local-docker launcher / the cloud cold-start injection), shaped
//! `{ "<memberId>": { "githubToken"?, "glabConfigYml"? } }`. It is reloaded
//! lazily when its mtime changes, so a live re-sync (the launcher rewrites the
//! file on a new `PUT /team/forge-identity`) is picked up WITHOUT a container
//! restart. No env var (desktop) → empty store → every lookup `None` → the forge
//! layer falls back to the repo-bound account, unchanged.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, RwLock};
use std::time::SystemTime;

use serde::Deserialize;

/// gh stores only the github.com token (the broker captures github.com); GHE
/// hosts have no per-member token here and fall back to the repo-bound account.
const GITHUB_HOST: &str = "github.com";

#[derive(Clone, Default, Debug)]
pub(crate) struct MemberForgeCreds {
    /// The member's github.com token (gh OAuth/PAT).
    pub github_token: Option<String>,
    /// The member's glab tokens, keyed by GitLab host.
    pub glab_tokens: HashMap<String, String>,
    /// The member's GitHub login, for per-member commit authorship.
    pub login: Option<String>,
}

#[derive(Default)]
struct StoreState {
    creds: HashMap<String, MemberForgeCreds>,
    /// The (path, mtime) the current `creds` were loaded from, to skip reloads
    /// when nothing changed.
    loaded: Option<(PathBuf, Option<SystemTime>)>,
}

static STORE: LazyLock<RwLock<StoreState>> = LazyLock::new(|| RwLock::new(StoreState::default()));

/// Wire shape of the injected JSON (camelCase, matching the upload body).
#[derive(Deserialize)]
struct RawMemberCreds {
    #[serde(rename = "githubToken")]
    github_token: Option<String>,
    #[serde(rename = "glabConfigYml")]
    glab_config_yml: Option<String>,
    login: Option<String>,
}

fn source_path() -> Option<PathBuf> {
    std::env::var_os("HELMOR_FORGE_MEMBERS_PATH").map(PathBuf::from)
}

/// Reload the store from `$HELMOR_FORGE_MEMBERS_PATH` if its mtime changed. Cheap
/// (one stat) when unchanged; no-op when the env var is unset (desktop).
fn ensure_fresh() {
    let Some(path) = source_path() else {
        return;
    };
    let mtime = std::fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .ok();

    if let Ok(state) = STORE.read() {
        if state.loaded.as_ref() == Some(&(path.clone(), mtime)) {
            return;
        }
    }

    let creds = load_file(&path);
    if let Ok(mut state) = STORE.write() {
        state.creds = creds;
        state.loaded = Some((path, mtime));
    }
}

/// Parse the injected members file into the in-memory shape. A missing /
/// malformed file yields an empty map (every lookup falls back).
fn load_file(path: &PathBuf) -> HashMap<String, MemberForgeCreds> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(raw) = serde_json::from_str::<HashMap<String, RawMemberCreds>>(&text) else {
        return HashMap::new();
    };
    raw.into_iter()
        .map(|(member_id, entry)| {
            let glab_tokens = entry
                .glab_config_yml
                .as_deref()
                .map(parse_glab_tokens)
                .unwrap_or_default();
            (
                member_id,
                MemberForgeCreds {
                    github_token: entry.github_token,
                    glab_tokens,
                    login: entry.login,
                },
            )
        })
        .collect()
}

fn github_token(member_id: &str) -> Option<String> {
    STORE
        .read()
        .ok()?
        .creds
        .get(member_id)?
        .github_token
        .clone()
}

fn glab_token(member_id: &str, host: &str) -> Option<String> {
    STORE
        .read()
        .ok()?
        .creds
        .get(member_id)?
        .glab_tokens
        .get(host)
        .cloned()
}

/// The acting member's github.com token, if any (team mode). Only github.com —
/// GHE falls back to the repo-bound account.
pub(crate) fn acting_github_token(host: &str) -> Option<String> {
    if host != GITHUB_HOST {
        return None;
    }
    ensure_fresh();
    github_token(&super::acting_member::current()?)
}

/// The acting member's glab token for `host`, if any (team mode).
pub(crate) fn acting_glab_token(host: &str) -> Option<String> {
    ensure_fresh();
    glab_token(&super::acting_member::current()?, host)
}

/// All of a specific member's forge creds (token + login), for callers that know
/// the member explicitly rather than via the ambient — e.g. the post-turn
/// auto-commit, which authors the commit as that member.
pub(crate) fn member_for(member_id: &str) -> Option<MemberForgeCreds> {
    ensure_fresh();
    STORE.read().ok()?.creds.get(member_id).cloned()
}

/// Parse `host -> token` from a glab `config.yml` (4-space host keys, deeper
/// `token:` fields).
fn parse_glab_tokens(config_yml: &str) -> HashMap<String, String> {
    let mut tokens = HashMap::new();
    let mut in_hosts = false;
    let mut current_host: Option<String> = None;
    for line in config_yml.lines() {
        if line.trim_end() == "hosts:" {
            in_hosts = true;
            continue;
        }
        if !in_hosts {
            continue;
        }
        // A non-indented line ends the `hosts:` block.
        if line.chars().next().is_some_and(|c| !c.is_whitespace()) {
            break;
        }
        let Some(rest) = line.strip_prefix("    ") else {
            continue;
        };
        if rest.starts_with(' ') {
            // Deeper-indented field under the current host.
            if let Some(tok) = rest.trim_start().strip_prefix("token:") {
                if let Some(host) = &current_host {
                    let tok = tok.trim();
                    if !tok.is_empty() {
                        tokens.insert(host.clone(), tok.to_string());
                    }
                }
            }
        } else if let Some(name) = rest.trim_end().strip_suffix(':') {
            // 4-space host key.
            current_host = Some(name.trim().to_string());
        }
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test-only: install creds directly, bypassing the file source.
    fn set_for_test(creds: HashMap<String, MemberForgeCreds>) {
        let mut state = STORE.write().unwrap();
        state.creds = creds;
        // Pin a sentinel so `ensure_fresh` (no env var in tests) never clobbers it.
        state.loaded = None;
    }

    #[test]
    fn parse_glab_tokens_extracts_per_host_tokens() {
        let cfg = "hosts:\n    gitlab.com:\n        token: glpat-aaa\n        api_protocol: https\n    ngit.hundun.cn:\n        token: glpat-bbb\nother: x\n";
        let tokens = parse_glab_tokens(cfg);
        assert_eq!(
            tokens.get("gitlab.com").map(String::as_str),
            Some("glpat-aaa")
        );
        assert_eq!(
            tokens.get("ngit.hundun.cn").map(String::as_str),
            Some("glpat-bbb")
        );
        assert_eq!(tokens.len(), 2);
    }

    #[test]
    fn load_file_maps_raw_json_and_parses_glab() {
        let raw = r#"{"m1":{"githubToken":"gho_x","glabConfigYml":"hosts:\n    ngit.hundun.cn:\n        token: glpat_x\n"}}"#;
        let parsed: HashMap<String, RawMemberCreds> = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed["m1"].github_token.as_deref(), Some("gho_x"));
        let tokens = parse_glab_tokens(parsed["m1"].glab_config_yml.as_deref().unwrap());
        assert_eq!(
            tokens.get("ngit.hundun.cn").map(String::as_str),
            Some("glpat_x")
        );
    }

    #[test]
    fn acting_tokens_resolve_via_thread_local() {
        set_for_test(HashMap::from([(
            "m1".to_string(),
            MemberForgeCreds {
                github_token: Some("gho_m1".to_string()),
                glab_tokens: HashMap::from([(
                    "ngit.hundun.cn".to_string(),
                    "glpat_m1".to_string(),
                )]),
                login: Some("m1login".to_string()),
            },
        )]));

        super::super::acting_member::scope_thread(Some("m1".to_string()), || {
            assert_eq!(acting_github_token("github.com").as_deref(), Some("gho_m1"));
            // GHE host has no stored token → fall back (None).
            assert_eq!(acting_github_token("ghe.corp.example").as_deref(), None);
            assert_eq!(
                acting_glab_token("ngit.hundun.cn").as_deref(),
                Some("glpat_m1")
            );
            assert_eq!(acting_glab_token("gitlab.com").as_deref(), None);
        });

        // No acting member bound → no override (desktop path).
        assert_eq!(acting_github_token("github.com"), None);
        assert_eq!(acting_glab_token("ngit.hundun.cn"), None);
    }
}
