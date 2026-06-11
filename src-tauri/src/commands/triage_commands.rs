//! Tauri commands for the AI-triage feature.

use tauri::{AppHandle, Runtime, State};

use crate::commands::common::{run_blocking, CmdResult};
use crate::triage::fetcher::{cache as fetcher_cache, storage as fetcher_storage};
use crate::triage::{self, ActiveStatusStore, TriageConfig, TriageStatus};
use crate::ui_sync::{self, UiMutationEvent};

#[tauri::command]
pub async fn get_triage_config() -> CmdResult<TriageConfig> {
    run_blocking(triage::load_config).await
}

#[tauri::command]
pub async fn update_triage_config<R: Runtime>(
    app: AppHandle<R>,
    config: TriageConfig,
) -> CmdResult<()> {
    run_blocking(move || triage::save_config(&config)).await?;
    ui_sync::publish(&app, UiMutationEvent::TriageConfigChanged);
    Ok(())
}

#[tauri::command]
pub async fn get_triage_active_status(
    store: State<'_, ActiveStatusStore>,
) -> CmdResult<TriageStatus> {
    Ok(store.snapshot())
}

#[tauri::command]
pub async fn trigger_triage_tick_now<R: Runtime>(app: AppHandle<R>) -> CmdResult<String> {
    run_blocking(move || triage::trigger_tick_now(&app)).await
}

#[tauri::command]
pub async fn cancel_triage_tick<R: Runtime>(app: AppHandle<R>) -> CmdResult<bool> {
    run_blocking(move || triage::cancel_tick_in_flight(&app)).await
}

/// Open candidates, newest-first.
#[tauri::command]
pub async fn list_open_triage_candidates(
    limit: u32,
) -> CmdResult<Vec<fetcher_storage::CandidateRow>> {
    let lim = limit.clamp(1, 200) as i64;
    run_blocking(move || fetcher_storage::list_open_candidates(lim)).await
}

#[tauri::command]
pub async fn count_open_triage_candidates() -> CmdResult<i64> {
    run_blocking(fetcher_storage::count_open_candidates).await
}

/// Read a candidate payload; optional grep filter, 8 KB truncation cap.
#[tauri::command]
pub async fn read_triage_candidate(
    candidate_id: String,
    grep: Option<String>,
) -> CmdResult<String> {
    run_blocking(move || read_candidate_inner(&candidate_id, grep.as_deref())).await
}

#[tauri::command]
pub async fn record_triage_decision(
    candidate_id: String,
    decision: String,
    reason: Option<String>,
) -> CmdResult<()> {
    run_blocking(move || {
        fetcher_storage::record_decision(&candidate_id, &decision, reason.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn get_triage_source_health() -> CmdResult<Vec<triage::source_health::SourceHealth>> {
    Ok(triage::source_health::detect_all().await)
}

const READ_MAX_BYTES: usize = 8 * 1024;
const GREP_CONTEXT_LINES: usize = 3;

fn read_candidate_inner(candidate_id: &str, grep: Option<&str>) -> anyhow::Result<String> {
    let row = fetcher_storage::get_candidate(candidate_id)?
        .ok_or_else(|| anyhow::anyhow!("candidate {candidate_id} not found"))?;
    let body = fetcher_cache::read_payload(&row.payload_path)?;
    match grep {
        Some(pattern) if !pattern.trim().is_empty() => Ok(grep_filter(&body, pattern.trim())),
        _ => Ok(truncate_bytes(&body, READ_MAX_BYTES)),
    }
}

/// Line-grep, case-insensitive, ±3 lines context joined by `---`.
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
    // Walk back to a UTF-8 char boundary.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grep_filter_keeps_context_around_match() {
        let body = "a\nb\nNEEDLE\nd\ne\nf\ng\nh\ni\nj\nk\nNEEDLE2 should not match\nm\n";
        let got = grep_filter(body, "NEEDLE");
        assert!(got.contains("NEEDLE"));
        assert!(got.contains("a") && got.contains("f")); // 3 lines context
                                                         // Second NEEDLE2 also matches because it contains "NEEDLE" as substring.
        assert!(got.contains("NEEDLE2"));
    }

    #[test]
    fn grep_filter_empty_match_returns_hint() {
        let got = grep_filter("hello world\n", "missing");
        assert!(got.contains("no lines matched"));
    }

    #[test]
    fn truncate_bytes_respects_utf8() {
        let body = format!("{}{}", "x".repeat(8190), "你"); // last char is 3 bytes → boundary crossing
        let got = truncate_bytes(&body, 8192);
        assert!(got.starts_with("xxxxx"));
        assert!(got.contains("truncated"));
    }
}
