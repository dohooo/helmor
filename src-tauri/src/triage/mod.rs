//! AI-triage. Fetcher (`fetcher::spawn_scheduler`) runs every 5 min and
//! auto-fires a Layer-2 tick when triage + auto_run are on;
//! manual fires via `trigger_tick_now`.

pub mod active_status;
pub mod attachments;
pub mod config;
pub mod fetcher;
pub mod priming;
pub mod scheduler;
pub mod source_health;
pub mod workspace_factory;

pub use active_status::{
    ActiveStatus, ActiveStatusStore, LastTickOutcome, TickOutcome, ToolCallRecord, TriageStatus,
};
pub use config::{load_config, save_config, TriageConfig};
pub use priming::{
    combine_prefixes, load_priming_prefix_for_session, mark_consumed_for_session, wrap_priming,
};
pub use scheduler::{cancel_tick_in_flight, trigger_tick_now};
pub use workspace_factory::{
    create_ai_workspace, CreateAiWorkspaceParams, CreateAiWorkspaceResult,
};
