//! In-memory snapshot of the currently-running tick + last completion stamp.

use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

const MAX_TOOL_CALLS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    pub at: String,
    pub tool: String,
    pub args_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveStatus {
    pub tick_id: String,
    pub started_at: String,
    pub turn_count: u32,
    pub tool_count: u32,
    pub last_tool_name: Option<String>,
    pub last_update_at: String,
    pub recent_tool_calls: Vec<ToolCallRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriageStatus {
    pub active: Option<ActiveStatus>,
    pub last_completed_at: Option<String>,
}

#[derive(Default)]
pub struct ActiveStatusStore {
    inner: Mutex<Option<ActiveStatus>>,
    last_completed_at: Mutex<Option<String>>,
}

impl ActiveStatusStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> TriageStatus {
        let active = self.inner.lock().ok().and_then(|g| g.clone());
        let last_completed_at = self.last_completed_at.lock().ok().and_then(|g| g.clone());
        TriageStatus {
            active,
            last_completed_at,
        }
    }

    pub fn begin(&self, tick_id: &str) {
        let now = now_iso();
        if let Ok(mut g) = self.inner.lock() {
            *g = Some(ActiveStatus {
                tick_id: tick_id.to_string(),
                started_at: now.clone(),
                turn_count: 0,
                tool_count: 0,
                last_tool_name: None,
                last_update_at: now,
                recent_tool_calls: Vec::new(),
            });
        }
    }

    pub fn end(&self) {
        if let Ok(mut g) = self.inner.lock() {
            *g = None;
        }
    }

    /// Stamp the most recent successful tick completion. Used by the UI to
    /// show "Last completed Xm ago" next to the Run button.
    pub fn mark_completed(&self) {
        if let Ok(mut g) = self.last_completed_at.lock() {
            *g = Some(now_iso());
        }
    }

    pub fn set_turn(&self, turn: u32) {
        if let Ok(mut g) = self.inner.lock() {
            if let Some(s) = g.as_mut() {
                s.turn_count = turn;
                s.last_update_at = now_iso();
            }
        }
    }

    pub fn push_tool(&self, tool: &str, args_preview: &str) {
        if let Ok(mut g) = self.inner.lock() {
            if let Some(s) = g.as_mut() {
                s.tool_count += 1;
                s.last_tool_name = Some(tool.to_string());
                let now = now_iso();
                s.last_update_at = now.clone();
                s.recent_tool_calls.push(ToolCallRecord {
                    at: now,
                    tool: tool.to_string(),
                    args_preview: args_preview.to_string(),
                });
                let len = s.recent_tool_calls.len();
                if len > MAX_TOOL_CALLS {
                    s.recent_tool_calls.drain(0..len - MAX_TOOL_CALLS);
                }
            }
        }
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
