//! In-app team-cloud auto-deploy. A thin Rust layer over the provision ENGINE
//! (`cloud/scripts/provision-team.ts`): it resolves the script + a JS runtime
//! via [`tooling`], runs it, and forwards the script's JSON progress protocol
//! to the frontend over an `ipc::Channel` while returning the terminal result.
//!
//! Dev runs the repo `.ts` under PATH bun; a release bundle runs the staged
//! `vendor/team-cloud/scripts/*.mjs` under the vendored Node runtime, with
//! wrangler + the Worker source shipping in the same staged payload
//! (stage-vendor.ts's team-cloud lane) — see `tooling` for the exact rules.
//!
//! Secrets (the Cloudflare OAuth token wrangler holds, the generated admin
//! token) stay inside the script/wrangler process; only the Worker URL + admin
//! token are returned, and nothing is logged from here.

mod tooling;

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use super::common::CmdResult;
use tooling::CloudScript;

/// One streamed step of the deploy, mirrored from the script's `progress` lines.
/// Serializes to `{ step, status, message }` (matches `TeamDeployProgress` in
/// `src/lib/api.ts`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamDeployProgress {
    step: String,
    status: String,
    message: String,
}

/// Terminal outcome returned to the frontend (matches `TeamDeployResult` in
/// `src/lib/api.ts`): `{kind:"deployed",...}` or `{kind:"needs-upgrade",...}`.
#[derive(Serialize)]
#[serde(tag = "kind")]
pub enum TeamDeployResult {
    #[serde(rename = "deployed")]
    Deployed {
        #[serde(rename = "workerUrl")]
        worker_url: String,
        #[serde(rename = "adminToken")]
        admin_token: String,
    },
    #[serde(rename = "needs-upgrade")]
    NeedsUpgrade {
        #[serde(rename = "upgradeUrl")]
        upgrade_url: String,
    },
}

/// A single JSON line the provision script emits on stdout (its machine
/// protocol). Anything that doesn't parse as this is wrangler's own chatter and
/// is skipped.
#[derive(Deserialize)]
#[serde(tag = "kind")]
enum ScriptLine {
    #[serde(rename = "progress")]
    Progress {
        step: String,
        status: String,
        message: String,
    },
    #[serde(rename = "deployed")]
    Deployed {
        #[serde(rename = "workerUrl")]
        worker_url: String,
        #[serde(rename = "adminToken")]
        admin_token: String,
    },
    #[serde(rename = "needs-upgrade")]
    NeedsUpgrade {
        #[serde(rename = "upgradeUrl")]
        upgrade_url: String,
    },
}

/// The provision engine. An env override aids manual testing / the
/// adversarial harness.
fn resolve_provision_script() -> anyhow::Result<CloudScript> {
    if let Ok(path) = std::env::var("HELMOR_PROVISION_SCRIPT") {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Ok(tooling::for_override(p));
        }
    }
    tooling::resolve("provision-team")
}

/// Run the provision script, forwarding progress to `channel`, returning the
/// terminal result. Blocking — call from `spawn_blocking`.
///
/// No `current_dir`: the scripts are cwd-independent (they locate their own
/// payload via `import.meta.url` and give wrangler a writable temp dir — the
/// bundled copy lives in the app's read-only Resources).
fn run_provision(channel: Channel<TeamDeployProgress>) -> anyhow::Result<TeamDeployResult> {
    let CloudScript { runtime, script } = resolve_provision_script()?;

    let mut command = Command::new(&runtime);
    command
        .arg(&script)
        .env("WRANGLER_SEND_METRICS", "false")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    let mut child = command.spawn().with_context(|| {
        format!(
            "Failed to start the team provisioner ({} {})",
            runtime.display(),
            script.display()
        )
    })?;

    let stdout = child
        .stdout
        .take()
        .context("provisioner produced no stdout")?;

    let mut result: Option<TeamDeployResult> = None;
    for line in BufReader::new(stdout).lines() {
        let line = line?;
        match serde_json::from_str::<ScriptLine>(&line) {
            Ok(ScriptLine::Progress {
                step,
                status,
                message,
            }) => {
                let _ = channel.send(TeamDeployProgress {
                    step,
                    status,
                    message,
                });
            }
            Ok(ScriptLine::Deployed {
                worker_url,
                admin_token,
            }) => {
                result = Some(TeamDeployResult::Deployed {
                    worker_url,
                    admin_token,
                });
            }
            Ok(ScriptLine::NeedsUpgrade { upgrade_url }) => {
                result = Some(TeamDeployResult::NeedsUpgrade { upgrade_url });
            }
            // wrangler's own stdout chatter — not protocol, ignore.
            Err(_) => {}
        }
    }

    let status = child.wait().context("provisioner wait failed")?;
    result.ok_or_else(|| {
        anyhow::anyhow!(
            "Cloud setup ended without a result (exit {:?}).",
            status.code()
        )
    })
}

/// Stand up a fresh team-cloud backend on the operator's own Cloudflare account
/// (drives `wrangler` via the provision script). LOCAL_ONLY — runs on the
/// desktop host (wrangler + the browser sign-in live here, not in the sandbox).
#[tauri::command]
pub async fn deploy_team_cloud(
    channel: Channel<TeamDeployProgress>,
) -> CmdResult<TeamDeployResult> {
    let result = tauri::async_runtime::spawn_blocking(move || run_provision(channel))
        .await
        .map_err(|e| anyhow::anyhow!("provision task join failed: {e}"))??;
    Ok(result)
}

/// Run a `cloud/scripts` helper and capture its stdout (the machine payload).
/// Blocking — call from `spawn_blocking`.
fn run_cloud_script_capture(script_stem: &str, args: &[&str]) -> anyhow::Result<String> {
    let CloudScript { runtime, script } = tooling::resolve(script_stem)?;

    let mut command = Command::new(&runtime);
    command
        .arg(&script)
        .args(args)
        .env("WRANGLER_SEND_METRICS", "false")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    let output = command.output().with_context(|| {
        format!(
            "Failed to run the team-containers helper ({} {})",
            runtime.display(),
            script.display()
        )
    })?;
    if !output.status.success() {
        anyhow::bail!(
            "team-containers {} failed (exit {:?})",
            args.first().copied().unwrap_or(""),
            output.status.code()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// List the operator's remote Cloudflare Containers — the raw
/// `wrangler containers list --json` payload (the frontend parses it). Dev-only
/// tooling. LOCAL_ONLY — runs wrangler on the desktop host.
#[tauri::command]
pub async fn list_team_containers() -> CmdResult<String> {
    let json = tauri::async_runtime::spawn_blocking(|| {
        run_cloud_script_capture("team-containers", &["list"])
    })
    .await
    .map_err(|e| anyhow::anyhow!("list task join failed: {e}"))??;
    Ok(json)
}

/// Delete a remote Cloudflare Container by id. Dev-only tooling. LOCAL_ONLY.
#[tauri::command]
pub async fn delete_team_container(id: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        run_cloud_script_capture("team-containers", &["delete", &id])
    })
    .await
    .map_err(|e| anyhow::anyhow!("delete task join failed: {e}"))??;
    Ok(())
}
