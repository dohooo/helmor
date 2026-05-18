mod config;
mod events;
mod service;
mod state;

#[cfg(test)]
mod tests;

pub use events::{UpdateStatusSnapshot, APP_UPDATE_STATUS_EVENT};
pub use service::{
    configure, install_downloaded_update, install_pending_on_exit_blocking, maybe_trigger_on_focus,
    maybe_trigger_on_resume, snapshot, spawn_interval_worker, spawn_startup_check, trigger_check,
    CheckReason,
};
