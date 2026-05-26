//! `triage.*` host methods — Layer-2 LLM's only window into Helmor.
//!
//! Replaces the old `forge.*` / `lark.*` / `slack.*` LLM-facing surface.
//! The sidecar agent calls these to:
//!   - read open candidates (handed to it pre-formatted in the prompt,
//!     but it can re-query if it dismisses some and wants more)
//!   - read one candidate's full payload (with optional grep)
//!   - record a decision (skip / dismissed); proposals still flow
//!     through the existing `triageProposal` event so the scheduler can
//!     drive the workspace-creation path.

use anyhow::Result;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::triage::fetcher::{cache as fetcher_cache, storage as fetcher_storage};

pub async fn dispatch<R: Runtime>(
    _app: AppHandle<R>,
    method: &str,
    params: Value,
) -> Result<Value> {
    match method {
        "list_open_candidates" => list_open_candidates(params).await,
        "read_candidate" => read_candidate(params).await,
        "record_decision" => record_decision(params).await,
        _ => Err(crate::sidecar_host::unknown_method(method)),
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ListOpenParams {
    limit: Option<u32>,
}

async fn list_open_candidates(params: Value) -> Result<Value> {
    let p: ListOpenParams = serde_json::from_value(params)?;
    let limit = p.limit.unwrap_or(20).clamp(1, 200) as i64;
    let rows =
        tauri::async_runtime::spawn_blocking(move || fetcher_storage::list_open_candidates(limit))
            .await??;
    Ok(serde_json::to_value(rows)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadCandidateParams {
    candidate_id: String,
    #[serde(default)]
    grep: Option<String>,
    /// Return only the last N "## "-delimited message blocks. Mutually
    /// exclusive with `grep`; `tail` wins if both are set. Useful on
    /// chat candidates where the LLM wants the freshest activity even
    /// when the file is bigger than `READ_MAX_BYTES`.
    #[serde(default)]
    tail: Option<u32>,
}

const READ_MAX_BYTES: usize = 8 * 1024;
const GREP_CONTEXT_LINES: usize = 3;
const TAIL_MAX_BLOCKS: u32 = 200;

async fn read_candidate(params: Value) -> Result<Value> {
    let p: ReadCandidateParams = serde_json::from_value(params)?;
    let body = tauri::async_runtime::spawn_blocking(move || -> Result<String> {
        let row = fetcher_storage::get_candidate(&p.candidate_id)?
            .ok_or_else(|| anyhow::anyhow!("candidate {} not found", p.candidate_id))?;
        let raw = fetcher_cache::read_payload(&row.payload_path)?;
        let body = if let Some(n) = p.tail.filter(|n| *n > 0) {
            tail_blocks(&raw, n.min(TAIL_MAX_BLOCKS) as usize)
        } else if let Some(pattern) = p.grep.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            grep_filter(&raw, pattern)
        } else {
            truncate_bytes(&raw, READ_MAX_BYTES)
        };
        Ok(body)
    })
    .await??;
    Ok(json!({ "body": body }))
}

/// Return the file's header + the last `n` "## "-delimited blocks.
/// Blocks are detected by lines starting with `## ` — that's the
/// per-message header `im::default_message_block` emits. If the file
/// has fewer blocks than requested, returns the whole file.
fn tail_blocks(body: &str, n: usize) -> String {
    // Find every line index that starts a block.
    let mut block_starts: Vec<usize> = body
        .match_indices("\n## ")
        .map(|(i, _)| i + 1) // skip the leading \n
        .collect();
    if let Some(idx) = body.find("## ") {
        if idx == 0 && !block_starts.contains(&0) {
            block_starts.insert(0, 0);
        }
    }
    if block_starts.len() <= n {
        return body.to_string();
    }
    let header_end = block_starts[0];
    let tail_start = block_starts[block_starts.len() - n];
    let mut out = String::with_capacity(header_end + (body.len() - tail_start) + 64);
    out.push_str(&body[..header_end]);
    out.push_str(&format!(
        "\n…(omitted {} earlier message block(s))\n\n",
        block_starts.len() - n
    ));
    out.push_str(&body[tail_start..]);
    out
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordDecisionParams {
    candidate_id: String,
    decision: String,
    #[serde(default)]
    reason: Option<String>,
}

async fn record_decision(params: Value) -> Result<Value> {
    let p: RecordDecisionParams = serde_json::from_value(params)?;
    tauri::async_runtime::spawn_blocking(move || {
        fetcher_storage::record_decision(&p.candidate_id, &p.decision, p.reason.as_deref())
    })
    .await??;
    Ok(json!({ "ok": true }))
}

fn grep_filter(body: &str, needle: &str) -> String {
    let lower_needle = needle.to_lowercase();
    let lines: Vec<&str> = body.lines().collect();
    let mut keep = vec![false; lines.len()];
    for (i, line) in lines.iter().enumerate() {
        if line.to_lowercase().contains(&lower_needle) {
            let from = i.saturating_sub(GREP_CONTEXT_LINES);
            let to = (i + GREP_CONTEXT_LINES + 1).min(lines.len());
            for k in keep.iter_mut().take(to).skip(from) {
                *k = true;
            }
        }
    }
    let mut out = String::new();
    let mut in_block = false;
    for (i, line) in lines.iter().enumerate() {
        if keep[i] {
            if !in_block && !out.is_empty() {
                out.push_str("---\n");
            }
            out.push_str(line);
            out.push('\n');
            in_block = true;
        } else if in_block {
            in_block = false;
        }
    }
    if out.is_empty() {
        return format!("(no lines matched `{needle}`)\n");
    }
    out
}

fn truncate_bytes(body: &str, max: usize) -> String {
    if body.len() <= max {
        return body.to_string();
    }
    let mut end = max;
    while end > 0 && !body.is_char_boundary(end) {
        end -= 1;
    }
    let truncated = &body[..end];
    format!(
        "{truncated}\n\n…(truncated {} bytes; pass `grep=<pattern>` to filter)",
        body.len() - end
    )
}
