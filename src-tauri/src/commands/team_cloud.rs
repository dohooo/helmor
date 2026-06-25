//! In-app team-cloud auto-deploy. A thin Rust layer over the provision ENGINE
//! (`cloud/scripts/provision-team.ts`): it locates Bun + the script, runs it,
//! and forwards the script's JSON progress protocol to the frontend over an
//! `ipc::Channel` while returning the terminal result.
//!
//! DEV-first: the script is a repo file, resolved relative to the working dir
//! (like `resolve_sidecar_path`). A release build doesn't bundle it yet, so the
//! command surfaces a clear "use Advanced setup" error there — the frontend's
//! create-flow already falls back gracefully.
//!
//! Secrets (the Cloudflare OAuth token wrangler holds, the generated admin
//! token) stay inside the script/wrangler process; only the Worker URL + admin
//! token are returned, and nothing is logged from here.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use super::common::CmdResult;

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

/// Locate `cloud/scripts/provision-team.ts`. Mirrors `resolve_sidecar_path`'s
/// dev resolution: Tauri dev sets cwd to `src-tauri/`, so check the parent too.
fn resolve_provision_script() -> anyhow::Result<PathBuf> {
    if let Ok(path) = std::env::var("HELMOR_PROVISION_SCRIPT") {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Ok(p);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for base in [cwd.as_path(), cwd.parent().unwrap_or(cwd.as_path())] {
            let candidate = base.join("cloud/scripts/provision-team.ts");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    anyhow::bail!(
        "Team auto-deploy isn't available in this build yet (the provisioner isn't bundled). Use Advanced setup in Settings → Team, or run a dev build."
    )
}

/// Run the provision script, forwarding progress to `channel`, returning the
/// terminal result. Blocking — call from `spawn_blocking`.
fn run_provision(channel: Channel<TeamDeployProgress>) -> anyhow::Result<TeamDeployResult> {
    let script = resolve_provision_script()?;
    let cloud_dir = script.parent().and_then(|p| p.parent());

    let mut command = Command::new(crate::platform::executable::resolve_for_spawn("bun"));
    command
        .arg("run")
        .arg(&script)
        .env("WRANGLER_SEND_METRICS", "false")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(dir) = cloud_dir {
        command.current_dir(dir);
    }

    let mut child = command
        .spawn()
        .context("Failed to start the team provisioner (is Bun installed?)")?;

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
