//! Locates the team-cloud provisioning toolkit: which script to run and which
//! JS runtime runs it.
//!
//! Dev: the repo's `cloud/scripts/<stem>.ts`, run under a PATH-resolved `bun`
//! (dev always launches from a shell, so PATH is real). Release: the staged
//! single-file `vendor/team-cloud/scripts/<stem>.mjs`, run under the vendored
//! Node at `vendor/node/` — zero PATH dependency, because a Finder-launched
//! app gets a minimal PATH without bun or node (round6 P1-1a). The staged
//! payload also carries wrangler + the Worker source; the scripts self-resolve
//! wrangler relative to their own location, so nothing here needs to know
//! where wrangler lives — EXCEPT a runtime hint: wrangler must never run under
//! bun (it swallows wrangler's output, round6 F-A), so the spawn points pass
//! the vendored Node's path as `HELMOR_WRANGLER_NODE` when it exists (see
//! [`vendored_node`]) and the scripts pick their wrangler runtime from it.

use std::path::{Path, PathBuf};

/// A resolved cloud-script invocation: spawn as `runtime <script> [args…]`.
#[derive(Debug)]
pub struct CloudScript {
    pub runtime: PathBuf,
    pub script: PathBuf,
}

/// Resolve `cloud/scripts/<stem>` — dev repo checkout first, then the release
/// bundle. Errors are user-facing (they surface in the create-team flow).
pub fn resolve(stem: &str) -> anyhow::Result<CloudScript> {
    // 1. Dev checkout: Tauri dev sets cwd to `src-tauri/`, so check the parent
    //    too (mirrors `resolve_sidecar_path`).
    if let Ok(cwd) = std::env::current_dir() {
        for base in [cwd.as_path(), cwd.parent().unwrap_or(cwd.as_path())] {
            let candidate = base.join("cloud/scripts").join(format!("{stem}.ts"));
            if candidate.is_file() {
                return Ok(CloudScript {
                    runtime: crate::platform::executable::resolve_for_spawn("bun"),
                    script: candidate,
                });
            }
        }
    }

    // 2. Release bundle: staged .mjs + vendored Node from the app resources.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(found) = resolve_bundled(&exe, stem)? {
            return Ok(found);
        }
    }

    anyhow::bail!(
        "The team-cloud setup tooling is missing: this build has no bundled copy \
         (vendor/team-cloud in the app resources) and no repo checkout \
         (cloud/scripts/{stem}.ts). If you installed Helmor, the installation \
         looks damaged — reinstalling repairs it. In development, run from the \
         repo with `bun run dev`."
    )
}

/// Runtime for an explicitly overridden script path (`HELMOR_PROVISION_SCRIPT`
/// — manual testing / the adversarial harness): `.ts` runs under PATH bun,
/// anything else under the vendored Node (PATH `node` as a last resort).
pub fn for_override(script: PathBuf) -> CloudScript {
    let runtime = if script.extension().is_some_and(|e| e == "ts") {
        crate::platform::executable::resolve_for_spawn("bun")
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|exe| find_in_roots(&resource_roots(&exe), &node_relative()))
            .unwrap_or_else(|| crate::platform::executable::resolve_for_spawn("node"))
    };
    CloudScript { runtime, script }
}

/// The vendored Node runtime, if this build carries one (release bundles
/// always do; a debug build has it at `target/debug/vendor/node/` once staged).
/// Used as the `HELMOR_WRANGLER_NODE` hint so the cloud scripts run wrangler
/// under node even when the script itself runs under bun (round6 F-A). `None`
/// (nothing staged) is fine — the scripts fall back to a PATH `node`.
pub fn vendored_node() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| vendored_node_in(&exe))
}

fn vendored_node_in(exe: &Path) -> Option<PathBuf> {
    find_in_roots(&resource_roots(exe), &node_relative())
}

/// `Ok(None)` = not a bundled install (caller falls through to the "missing"
/// error); `Err` = the bundled script exists but its runtime doesn't, which is
/// a damaged install and deserves its own message.
fn resolve_bundled(exe: &Path, stem: &str) -> anyhow::Result<Option<CloudScript>> {
    let roots = resource_roots(exe);
    let Some(script) = find_in_roots(&roots, &format!("vendor/team-cloud/scripts/{stem}.mjs"))
    else {
        return Ok(None);
    };
    let Some(runtime) = find_in_roots(&roots, &node_relative()) else {
        anyhow::bail!(
            "This Helmor installation has the team-cloud tooling but is missing \
             its Node runtime (vendor/node). The installation looks damaged — \
             reinstall Helmor to repair it."
        );
    };
    Ok(Some(CloudScript { runtime, script }))
}

fn node_relative() -> String {
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    format!("vendor/node/{node_name}")
}

/// Resource layouts differ per platform: Windows (NSIS/MSI) installs resources
/// next to the exe, macOS puts them in `<bundle>/Contents/Resources` (the exe
/// lives in `Contents/MacOS`). Probe both roots — same approach as
/// `forge::bundled` and `sidecar`'s bundled-agent resolution.
fn resource_roots(exe: &Path) -> Vec<PathBuf> {
    let Some(exe_dir) = exe.parent() else {
        return Vec::new();
    };
    let mut roots = vec![exe_dir.to_path_buf()];
    if let Some(contents_dir) = exe_dir.parent() {
        roots.push(contents_dir.join("Resources"));
    }
    roots
}

fn find_in_roots(roots: &[PathBuf], relative: &str) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| root.join(relative))
        .find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node_name() -> &'static str {
        if cfg!(windows) {
            "node.exe"
        } else {
            "node"
        }
    }

    fn write_file(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }

    #[test]
    fn bundled_resolves_macos_resources_layout() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("Helmor.app/Contents/MacOS/Helmor");
        let resources = root.path().join("Helmor.app/Contents/Resources");
        let script = resources.join("vendor/team-cloud/scripts/provision-team.mjs");
        let node = resources.join(format!("vendor/node/{}", node_name()));
        write_file(&script);
        write_file(&node);

        let found = resolve_bundled(&exe, "provision-team").unwrap().unwrap();

        assert_eq!(found.script, script);
        assert_eq!(found.runtime, node);
    }

    #[test]
    fn bundled_resolves_windows_next_to_exe_layout() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("Helmor/helmor.exe");
        let script = root
            .path()
            .join("Helmor/vendor/team-cloud/scripts/provision-team.mjs");
        let node = root
            .path()
            .join(format!("Helmor/vendor/node/{}", node_name()));
        write_file(&script);
        write_file(&node);

        let found = resolve_bundled(&exe, "provision-team").unwrap().unwrap();

        assert_eq!(found.script, script);
        assert_eq!(found.runtime, node);
    }

    #[test]
    fn bundled_script_without_node_runtime_is_a_damaged_install_error() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("Helmor.app/Contents/MacOS/Helmor");
        let script = root
            .path()
            .join("Helmor.app/Contents/Resources/vendor/team-cloud/scripts/provision-team.mjs");
        write_file(&script);

        let err = resolve_bundled(&exe, "provision-team").unwrap_err();

        assert!(err.to_string().contains("vendor/node"), "got: {err}");
    }

    #[test]
    fn bundled_absent_falls_through() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("Helmor.app/Contents/MacOS/Helmor");

        assert!(resolve_bundled(&exe, "provision-team").unwrap().is_none());
    }

    #[test]
    fn vendored_node_hint_requires_the_file_to_exist() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("Helmor.app/Contents/MacOS/Helmor");

        // Nothing staged → no hint (scripts fall back to PATH node).
        assert!(vendored_node_in(&exe).is_none());

        let node = root.path().join(format!(
            "Helmor.app/Contents/Resources/vendor/node/{}",
            node_name()
        ));
        write_file(&node);

        assert_eq!(vendored_node_in(&exe), Some(node));
    }

    #[test]
    fn override_ts_runs_under_bun_and_mjs_prefers_node() {
        let ts = for_override(PathBuf::from("/x/provision-team.ts"));
        assert!(ts.runtime.to_string_lossy().contains("bun"));

        let mjs = for_override(PathBuf::from("/x/provision-team.mjs"));
        assert!(mjs.runtime.to_string_lossy().contains("node"));
    }
}
