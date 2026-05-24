//! AI-triage: heartbeat-driven scan that creates AI workspaces.

pub mod active_status;
pub mod config;
pub mod priming;
pub mod scheduler;
pub mod sync;
pub mod workspace_factory;

pub use active_status::{
    ActiveStatus, ActiveStatusStore, LastTickOutcome, TickOutcome, ToolCallRecord, TriageStatus,
};
pub use config::{load_config, save_config, TriageConfig};
pub use priming::{
    combine_prefixes, load_priming_prefix_for_session, mark_consumed_for_session, wrap_priming,
};
pub use scheduler::{spawn_scheduler, trigger_tick_now};
pub use sync::{advance_sync, load_sync_map};
pub use workspace_factory::{
    create_ai_workspace, CreateAiWorkspaceParams, CreateAiWorkspaceResult,
};

pub const HEARTBEAT_SEC: u64 = 600;
