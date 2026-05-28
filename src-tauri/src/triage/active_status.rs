//! In-memory active tick + structured last-tick outcome for the UI.

use std::sync::Mutex;

use chrono::{Local, SecondsFormat};
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
    /// 1-indexed batch counter; 0 = not started.
    pub batch_index: u32,
    /// Upper bound (UI shows 'Batch n of N').
    pub batch_total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TickOutcome {
    CreatedWorkspaces { count: u32 },
    NoActionableItems,
    Cancelled,
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastTickOutcome {
    pub at: String,
    pub tick_id: String,
    pub outcome: TickOutcome,
    /// Agent's final assistant text, when present.
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriageStatus {
    pub active: Option<ActiveStatus>,
    pub last_outcome: Option<LastTickOutcome>,
}

#[derive(Default)]
pub struct ActiveStatusStore {
    inner: Mutex<Option<ActiveStatus>>,
    last_outcome: Mutex<Option<LastTickOutcome>>,
}

impl ActiveStatusStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> TriageStatus {
        let active = self.inner.lock().ok().and_then(|g| g.clone());
        let last_outcome = self.last_outcome.lock().ok().and_then(|g| g.clone());
        TriageStatus {
            active,
            last_outcome,
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
                batch_index: 0,
                batch_total: 0,
            });
        }
    }

    /// Bump current batch counter (1-indexed).
    pub fn set_batch(&self, index: u32, total: u32) {
        if let Ok(mut g) = self.inner.lock() {
            if let Some(s) = g.as_mut() {
                s.batch_index = index;
                s.batch_total = total;
                s.last_update_at = now_iso();
            }
        }
    }

    pub fn end(&self) {
        if let Ok(mut g) = self.inner.lock() {
            *g = None;
        }
    }

    pub fn record_outcome(&self, tick_id: &str, outcome: TickOutcome, summary: Option<String>) {
        if let Ok(mut g) = self.last_outcome.lock() {
            *g = Some(LastTickOutcome {
                at: now_iso(),
                tick_id: tick_id.to_string(),
                outcome,
                summary,
            });
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
    // RFC3339 with local UTC offset — readable + still parseable by JS `Date`.
    Local::now().to_rfc3339_opts(SecondsFormat::Millis, false)
}
