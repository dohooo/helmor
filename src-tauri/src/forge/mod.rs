//! Forge abstraction — unifies GitHub and GitLab (pull requests / merge
//! requests, CI status, CLI install + auth).
//!
//! Layout:
//!
//! - [`types`] — serialisable public types (`ForgeProvider`,
//!   `ForgeDetection`, `DetectionSignal`, `ForgeLabels`, change-request
//!   and action-status shapes).
//! - [`remote`] — git remote URL parsing.
//! - [`command`] — bounded subprocess execution for forge CLIs.
//! - [`detect`] — the layered detector that classifies a repo's forge at
//!   creation time and backs the "Why do we think so?" tooltip.
//! - [`cli_status`] — terminal-side helpers for the auth-login flow
//!   (open terminal + render auth command).
//! - [`accounts`] — per-account / per-host helpers (list logins, probe
//!   repo access, run CLI as a specific account, auto-bind on add-repo).
//! - [`workspace`] — per-workspace router that dispatches change-request
//!   calls to the right backend once a provider is resolved.
//! - [`github`] — GitHub SDK (CLI helpers, GraphQL).
//! - [`gitlab`] — GitLab REST client using `glab api`.

pub(crate) mod accounts;
pub(crate) mod avatar_cache;
mod branch;
mod bundled;
mod cli_status;
mod command;
mod detect;
pub mod github;
mod gitlab;
pub mod inbox;
mod provider;
pub(crate) mod remote;
mod types;
mod workspace;

pub use bundled::init as init_bundled_cli_paths;
pub(crate) use cli_status::forge_cli_auth_command;
pub use detect::detect_provider_for_repo;
pub(crate) use detect::detect_provider_for_repo_offline;
pub use inbox::{
    ForgeLabelOption, InboxDraftFilter, InboxFilters, InboxItem, InboxItemDetail, InboxKind,
    InboxKindLabels, InboxPage, InboxScopeFilter, InboxSortFilter, InboxSource, InboxState,
    InboxStateFilter, InboxStateTone, InboxToggles,
};
pub(crate) use provider::backend_for as forge_backend_for;
pub use types::{
    ActionProvider, ActionStatusKind, ChangeRequestInfo, DetectionSignal, ForgeActionItem,
    ForgeActionStatus, ForgeDetection, ForgeLabels, ForgeProvider, RemoteState,
};
pub use workspace::{
    close_workspace_change_request, get_workspace_forge, lookup_workspace_forge_action_status,
    lookup_workspace_forge_check_insert_text, merge_workspace_change_request,
    refresh_workspace_change_request,
};
