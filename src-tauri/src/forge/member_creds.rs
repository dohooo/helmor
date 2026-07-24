//! Per-member forge credentials available to the running serve host.
//!
//! Team mode (round6 P1-2a) injects ONE member's tokens into the shared
//! container: the team's forge "creator" (`teams.forge_identity_member_id`,
//! first-authorizer-wins), marked `creator: true` in the injected file. Every
//! other member's entry carries only their (non-secret) login, kept for
//! per-member commit authorship. Token lookups resolve the acting member's own
//! entry first and FALL BACK to the creator's tokens — so every member's
//! git/gh/glab network ops run under the creator's forge identity (the
//! intended creator-identity model; user product ruling), while a container
//! compromise can leak at most that single member's tokens.
//!
//! Source of truth = a JSON file at `$HELMOR_FORGE_MEMBERS_PATH` (written by the
//! local-docker launcher / the cloud cold-start injection), shaped
//! `{ "<memberId>": { "githubToken"?, "glabConfigYml"?, "login"?, "creator"? } }`.
//! (Pre-P1-2a files without the `creator` flag still parse — there is simply no
//! fallback entry.) It is reloaded lazily when its mtime changes, so a live
//! re-sync (the launcher rewrites the file on a new `PUT /team/forge-identity`)
//! is picked up WITHOUT a container restart. No env var (desktop) → empty store
//! → every lookup `None` → the forge layer falls back to the repo-bound
//! account, unchanged.

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
    /// The member id flagged `creator: true` in the injected file — the token
    /// fallback for acting members without their own tokens (P1-2a).
    creator_id: Option<String>,
    /// The (path, mtime) the current `creds` were loaded from, to skip reloads
    /// when nothing changed.
    loaded: Option<(PathBuf, Option<SystemTime>)>,
}

static STORE: LazyLock<RwLock<StoreState>> = LazyLock::new(|| RwLock::new(StoreState::default()));

/// Wire shape of the injected JSON (camelCase, matching the upload body).
/// `creator` (P1-2a) marks the single token-bearing entry; absent on
/// pre-P1-2a files, which therefore load with no fallback entry.
#[derive(Deserialize)]
struct RawMemberCreds {
    #[serde(rename = "githubToken")]
    github_token: Option<String>,
    #[serde(rename = "glabConfigYml")]
    glab_config_yml: Option<String>,
    login: Option<String>,
    creator: Option<bool>,
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

    let (creds, creator_id) = load_file(&path);
    if let Ok(mut state) = STORE.write() {
        state.creds = creds;
        state.creator_id = creator_id;
        state.loaded = Some((path, mtime));
    }
}

/// Parse the injected members file into the in-memory shape plus the creator
/// member id (the `creator: true` entry, if any). A missing / malformed file
/// yields an empty map (every lookup falls back).
fn load_file(path: &PathBuf) -> (HashMap<String, MemberForgeCreds>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (HashMap::new(), None);
    };
    let Ok(raw) = serde_json::from_str::<HashMap<String, RawMemberCreds>>(&text) else {
        return (HashMap::new(), None);
    };
    let mut creator_id = None;
    let creds = raw
        .into_iter()
        .map(|(member_id, entry)| {
            if entry.creator == Some(true) {
                creator_id = Some(member_id.clone());
            }
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
        .collect();
    (creds, creator_id)
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

/// The creator's member id, if the injected file flagged one (team mode).
fn creator_id() -> Option<String> {
    STORE.read().ok()?.creator_id.clone()
}

/// GitHub logins the shared container can actually authenticate as (team mode):
/// every injected member that carries a github.com token — the creator (P1-2a
/// creator-identity) plus any member with their own token. Empty on desktop (no
/// injected store) and for non-github hosts.
///
/// The gh account enumeration surfaces these (see `github/accounts.rs`) so forge
/// detection sees the identity the container really acts under. The injected
/// token is used for git/gh network ops but is NEVER written to gh's `hosts.yml`,
/// so `gh auth status` alone reports zero logins — which left the "Connect
/// GitHub" badge stuck as unauthenticated even for a repo the container can push
/// to (DF-R6-* team-cloud forge status).
pub(crate) fn github_logins(host: &str) -> Vec<String> {
    if host != GITHUB_HOST {
        return Vec::new();
    }
    ensure_fresh();
    let Ok(state) = STORE.read() else {
        return Vec::new();
    };
    let mut logins: Vec<String> = state
        .creds
        .values()
        .filter(|creds| creds.github_token.is_some())
        .filter_map(|creds| creds.login.clone())
        .collect();
    logins.sort();
    logins.dedup();
    logins
}

/// The acting member's github.com token (team mode), falling back to the
/// creator's token (P1-2a creator-identity model) when the acting member has
/// none — or when NO acting member is bound at all (e.g. the detached
/// auto-push thread). Desktop (empty store, no creator) still resolves `None`
/// everywhere → repo-bound account, unchanged. Only github.com — GHE falls
/// back to the repo-bound account.
pub(crate) fn acting_github_token(host: &str) -> Option<String> {
    if host != GITHUB_HOST {
        return None;
    }
    ensure_fresh();
    if let Some(member) = super::acting_member::current() {
        if let Some(token) = github_token(&member) {
            return Some(token);
        }
    }
    github_token(&creator_id()?)
}

/// The acting member's glab token for `host` (team mode), with the same
/// creator fallback as [`acting_github_token`].
pub(crate) fn acting_glab_token(host: &str) -> Option<String> {
    ensure_fresh();
    if let Some(member) = super::acting_member::current() {
        if let Some(token) = glab_token(&member, host) {
            return Some(token);
        }
    }
    glab_token(&creator_id()?, host)
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
        set_for_test_with_creator(creds, None);
    }

    /// Test-only: install creds + a creator binding (P1-2a fallback).
    fn set_for_test_with_creator(creds: HashMap<String, MemberForgeCreds>, creator: Option<&str>) {
        let mut state = STORE.write().unwrap();
        state.creds = creds;
        state.creator_id = creator.map(str::to_string);
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

    /// The STORE is process-global; serialize the tests that mutate it.
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn load_file_picks_up_creator_flag_and_tolerates_its_absence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("members.json");

        // New (P1-2a) shape: the creator entry carries tokens + the flag.
        std::fs::write(
            &path,
            r#"{"c1":{"githubToken":"gho_c1","login":"creator","creator":true},"m2":{"login":"member2"}}"#,
        )
        .unwrap();
        let (creds, creator) = load_file(&path);
        assert_eq!(creator.as_deref(), Some("c1"));
        assert_eq!(creds["c1"].github_token.as_deref(), Some("gho_c1"));
        assert_eq!(creds["m2"].github_token, None);
        assert_eq!(creds["m2"].login.as_deref(), Some("member2"));

        // Pre-P1-2a shape (no creator flag) still parses — just no fallback.
        std::fs::write(&path, r#"{"m1":{"githubToken":"gho_x"}}"#).unwrap();
        let (creds, creator) = load_file(&path);
        assert_eq!(creator, None);
        assert_eq!(creds["m1"].github_token.as_deref(), Some("gho_x"));
    }

    #[test]
    fn tokens_fall_back_to_creator_for_other_members_and_unbound_threads() {
        let _guard = TEST_LOCK.lock().unwrap();
        set_for_test_with_creator(
            HashMap::from([
                (
                    "c1".to_string(),
                    MemberForgeCreds {
                        github_token: Some("gho_creator".to_string()),
                        glab_tokens: HashMap::from([(
                            "ngit.hundun.cn".to_string(),
                            "glpat_creator".to_string(),
                        )]),
                        login: Some("creator".to_string()),
                    },
                ),
                (
                    "m2".to_string(),
                    MemberForgeCreds {
                        github_token: None,
                        glab_tokens: HashMap::new(),
                        login: Some("member2".to_string()),
                    },
                ),
            ]),
            Some("c1"),
        );

        // A non-creator acting member has no own token → creator's token
        // (creator-identity model: their pushes run AS the creator).
        super::super::acting_member::scope_thread(Some("m2".to_string()), || {
            assert_eq!(
                acting_github_token("github.com").as_deref(),
                Some("gho_creator")
            );
            assert_eq!(
                acting_glab_token("ngit.hundun.cn").as_deref(),
                Some("glpat_creator")
            );
            // Hosts nobody has a token for still resolve None.
            assert_eq!(acting_glab_token("gitlab.com"), None);
        });

        // No acting member bound (e.g. the detached auto-push thread) → the
        // creator's token, so post-turn pushes keep working once the remote
        // URL no longer embeds one (P1-8a).
        assert_eq!(
            acting_github_token("github.com").as_deref(),
            Some("gho_creator")
        );

        // Authorship lookups do NOT fall back — the commit is still attributed
        // to the actual member (or the global identity), never to the creator.
        assert_eq!(member_for("m2").unwrap().login.as_deref(), Some("member2"));

        set_for_test(HashMap::new()); // leave the global store clean
    }

    #[test]
    fn acting_tokens_resolve_via_thread_local() {
        let _guard = TEST_LOCK.lock().unwrap();
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

        // No acting member bound and NO creator flagged → no override
        // (desktop path, and pre-P1-2a injected files).
        assert_eq!(acting_github_token("github.com"), None);
        assert_eq!(acting_glab_token("ngit.hundun.cn"), None);

        set_for_test(HashMap::new()); // leave the global store clean
    }

    #[test]
    fn github_logins_surfaces_only_token_bearing_members() {
        let _guard = TEST_LOCK.lock().unwrap();
        set_for_test_with_creator(
            HashMap::from([
                (
                    "c1".to_string(),
                    MemberForgeCreds {
                        github_token: Some("gho_creator".to_string()),
                        glab_tokens: HashMap::new(),
                        login: Some("dohooo".to_string()),
                    },
                ),
                (
                    "m2".to_string(),
                    MemberForgeCreds {
                        github_token: None,
                        glab_tokens: HashMap::new(),
                        login: Some("member2".to_string()),
                    },
                ),
            ]),
            Some("c1"),
        );

        // Only the token-bearer (here the creator) is an account the container
        // can authenticate as; the login-only member is skipped.
        assert_eq!(github_logins("github.com"), vec!["dohooo".to_string()]);
        // No per-member token for GHE / non-github hosts here.
        assert!(github_logins("ghe.corp.example").is_empty());

        set_for_test(HashMap::new());
    }

    #[test]
    fn github_logins_empty_without_injected_store() {
        let _guard = TEST_LOCK.lock().unwrap();
        set_for_test(HashMap::new());
        // Desktop (no injected members) surfaces nothing → enumeration unchanged.
        assert!(github_logins("github.com").is_empty());
    }
}
