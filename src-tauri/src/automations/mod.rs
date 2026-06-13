//! Scheduled automations — Codex-style recurring prompts.
//!
//! An automation periodically injects a fixed prompt into a session and runs
//! a normal agent turn; the chat itself is the run history. Reliability model:
//!
//! - SQLite is the single source of truth (`models::automations`); the
//!   scheduler thread holds no durable state.
//! - The scheduler is a stateless 30s poll loop (`scheduler`); a tick that
//!   arrives late (app restart, machine sleep) simply sees overdue rows.
//! - Claim-before-dispatch: a CAS UPDATE on `next_run_at` makes each slot
//!   fire at most once, with `next_run_at` always recomputed from "now"
//!   (`schedule`) so long offline gaps produce exactly one catch-up run.
//! - Dispatch (`dispatch`) reuses the regular streaming engine with a no-op
//!   IPC channel — watchers and persistence behave exactly like a
//!   user-initiated send, and no UI focus is stolen.

pub mod dispatch;
pub mod ops;
pub mod schedule;
pub mod scheduler;
