//! Drift guard: every command the frontend `invoke`s must be reachable over the
//! companion HTTP surface.
//!
//! The companion server re-implements command routing in `companion/rpc.rs`
//! (non-streaming `/rpc`) and `companion/stream.rs` (streaming `/rpc-stream`).
//! That is a SECOND place every command is registered — the Tauri
//! `invoke_handler!` list being the first. If a new feature adds an
//! `invoke("foo")` on the frontend but nobody wires `foo` into the dispatch,
//! the desktop app works while the phone browser silently 400s on that call
//! (the feature breaks; React Query just shows an error / empty state).
//!
//! This test fails loudly at PR time instead: it scans every `invoke("name")`
//! in `src/` and asserts each name is either dispatched, no-op'd, streamed, or
//! explicitly listed as browser-unsupported below. It is the automated version
//! of the manual frontend-vs-dispatch diff that originally found ~60 unwired
//! commands.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Frontend commands intentionally NOT served over the companion HTTP surface.
/// Every entry carries a Tauri `Channel` (live PTY output / streaming progress)
/// and routes to `/rpc-stream`. Only the two app-critical streams are wired
/// there (`send_agent_message_stream`, `subscribe_ui_mutations`); the rest below
/// are niche enough that running them in a phone browser is out of scope, so the
/// transport degrades them to "no events" rather than crashing.
///
/// Do NOT add a plain request/response command here to silence the test — wire
/// it into `companion/rpc.rs` instead. This list is only for commands that
/// fundamentally cannot work without a Tauri `Channel` (interactive terminals,
/// repo-script output, live download progress).
const BROWSER_UNSUPPORTED: &[&str] = &[
    "execute_repo_script",
    "execute_repo_stop_command",
    "slack_prepare_thread_context",
    "spawn_agent_login_terminal",
    "spawn_forge_cli_auth_terminal",
    // Interactive PTY writing into the local macOS Keychain — Channel-bound
    // and desktop-only by nature.
    "spawn_keychain_store_terminal",
    "spawn_terminal",
    "subscribe_local_llm_downloads",
];

#[test]
fn every_frontend_invoke_is_reachable_in_the_companion() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let frontend_src = manifest.join("../src");

    let mut frontend = BTreeSet::new();
    let mut ts_files = Vec::new();
    collect_ts_files(&frontend_src, &mut ts_files);
    assert!(
        !ts_files.is_empty(),
        "found no frontend .ts/.tsx files under {} — did the layout change?",
        frontend_src.display(),
    );
    for file in &ts_files {
        let src = fs::read_to_string(file).unwrap_or_default();
        extract_invoke_names(&src, &mut frontend);
    }
    assert!(
        frontend.len() > 100,
        "only found {} frontend invoke() calls — the scanner likely broke",
        frontend.len(),
    );

    // Everything the dispatch / streaming layers name. This is a deliberately
    // loose superset (it also picks up argument keys), which is safe: extra
    // names can only *satisfy* the subset check, never hide a real gap.
    let mut handled = BTreeSet::new();
    for rel in ["src/companion/rpc.rs", "src/companion/stream.rs"] {
        let src = fs::read_to_string(manifest.join(rel)).unwrap_or_default();
        extract_quoted_names(&src, &mut handled);
    }

    let allow: BTreeSet<&str> = BROWSER_UNSUPPORTED.iter().copied().collect();

    let missing: Vec<&String> = frontend
        .iter()
        .filter(|cmd| !handled.contains(cmd.as_str()) && !allow.contains(cmd.as_str()))
        .collect();

    assert!(
        missing.is_empty(),
        "The companion HTTP dispatch is missing {} command(s) the frontend invoke()s:\n{}\n\n\
         Every invoke(\"cmd\") must be reachable on a phone browser. Fix by one of:\n\
         • add an arm in src/companion/rpc.rs (real handler, or the desktop-only no-op group), or\n\
         • handle it in src/companion/stream.rs (if it streams via a Channel), or\n\
         • if it carries a Channel and genuinely cannot work in a browser, add it to\n\
         \x20 BROWSER_UNSUPPORTED in this test WITH a reason.\n\
         Otherwise the feature works on desktop but silently breaks when opened on a phone.",
        missing.len(),
        missing
            .iter()
            .map(|c| format!("  - {c}"))
            .collect::<Vec<_>>()
            .join("\n"),
    );

    // Keep the allowlist honest: an entry the frontend no longer calls (or that
    // got wired into the dispatch) is dead and should be removed.
    let stale: Vec<&str> = BROWSER_UNSUPPORTED
        .iter()
        .filter(|cmd| !frontend.contains(**cmd) || handled.contains(**cmd))
        .copied()
        .collect();
    assert!(
        stale.is_empty(),
        "BROWSER_UNSUPPORTED has stale entries (no longer invoked, or now handled): {stale:?} — \
         remove them.",
    );
}

/// Recursively collect `.ts` / `.tsx` files, skipping test files and the test
/// support directory (which mocks `invoke` and would add phantom commands).
fn collect_ts_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().and_then(|n| n.to_str()) == Some("test") {
                continue;
            }
            collect_ts_files(&path, out);
        } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            let is_ts = name.ends_with(".ts") || name.ends_with(".tsx");
            if is_ts && !name.contains(".test.") {
                out.push(path);
            }
        }
    }
}

/// Pull every `invoke("name")` / `invoke<T>("name")` command name out of a
/// TypeScript source. Non-literal calls (`invoke(dynamic)`) are skipped — they
/// can't be checked statically and are vanishingly rare here.
fn extract_invoke_names(src: &str, out: &mut BTreeSet<String>) {
    let bytes = src.as_bytes();
    let mut search = 0;
    while let Some(rel) = src[search..].find("invoke") {
        let start = search + rel;
        search = start + "invoke".len();
        // Reject identifiers ending in `invoke` (e.g. `companionInvoke` is
        // PascalCase so won't match, but `_invoke` could): require the char
        // before to be a non-identifier char.
        if start > 0 {
            let prev = bytes[start - 1];
            if prev == b'_' || prev.is_ascii_alphanumeric() {
                continue;
            }
        }
        let mut j = search;
        // Optional generic: invoke<...>(
        if bytes.get(j) == Some(&b'<') {
            while j < bytes.len() && bytes[j] != b'>' {
                j += 1;
            }
            j += 1;
        }
        j = skip_ws(bytes, j);
        if bytes.get(j) != Some(&b'(') {
            continue;
        }
        j = skip_ws(bytes, j + 1);
        if bytes.get(j) != Some(&b'"') {
            continue;
        }
        let name_start = j + 1;
        let mut k = name_start;
        while k < bytes.len() && bytes[k] != b'"' {
            k += 1;
        }
        let name = &src[name_start..k];
        if is_command_name(name) {
            out.insert(name.to_string());
        }
    }
}

/// Pull every `"snake_case"` string literal out of a source file. Used on the
/// Rust dispatch files to gather dispatched + no-op + streamed command names
/// (plus harmless argument-key noise).
fn extract_quoted_names(src: &str, out: &mut BTreeSet<String>) {
    let bytes = src.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() && bytes[j] != b'"' {
                j += 1;
            }
            if is_command_name(&src[start..j]) {
                out.insert(src[start..j].to_string());
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
}

fn skip_ws(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// A Tauri command name: `snake_case`, lowercase ASCII + digits, no dots/spaces.
/// Excludes camelCase argument keys and dotted settings keys.
fn is_command_name(s: &str) -> bool {
    let mut chars = s.bytes();
    match chars.next() {
        Some(b) if b.is_ascii_lowercase() || b == b'_' => {}
        _ => return false,
    }
    s.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}
