//! Ambient "acting member" identity for per-member forge credential selection.
//!
//! In team mode a SHARED sandbox serves many members, so a forge op must run as
//! the member who TRIGGERED it (true per-member). The trusted member id is known
//! only at the companion dispatch boundary (`X-Helmor-Member-Id`), but the forge
//! layer that picks credentials runs deep inside a `spawn_blocking` closure —
//! across an async→blocking boundary a task-local can't cross on its own.
//!
//! So we bridge it in one place each:
//!   1. the dispatcher binds an async task-local ([`scope_async`]);
//!   2. `run_blocking` reads it ([`current_async`]) and re-binds it as a
//!      thread-local for the blocking closure ([`scope_thread`]);
//!   3. the forge layer reads the thread-local ([`current`]).
//!
//! On the desktop (no dispatcher scope) nothing is bound, so [`current`] is
//! `None` and the forge layer falls back to the repo-bound account — unchanged.

use std::cell::RefCell;
use std::future::Future;

tokio::task_local! {
    static ACTING_MEMBER_ASYNC: Option<String>;
}

thread_local! {
    static ACTING_MEMBER_THREAD: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Bind `member` as the acting member for the duration of `fut` (companion
/// dispatch). `None` = no specific member (admin / desktop path).
pub(crate) fn scope_async<F: Future>(
    member: Option<String>,
    fut: F,
) -> impl Future<Output = F::Output> {
    ACTING_MEMBER_ASYNC.scope(member, fut)
}

/// Read the async-bound acting member (call in the async context, BEFORE
/// `spawn_blocking`). `None` when no scope is active (desktop path).
pub(crate) fn current_async() -> Option<String> {
    ACTING_MEMBER_ASYNC.try_with(|m| m.clone()).ok().flatten()
}

/// Run `f` on this (blocking) thread with `member` bound as the acting member,
/// restoring the prior binding afterwards (panic-safe via the drop guard).
pub(crate) fn scope_thread<T>(member: Option<String>, f: impl FnOnce() -> T) -> T {
    let _guard = ThreadGuard::set(member);
    f()
}

/// The acting member id, if forge code is running on behalf of a specific member
/// (team mode). `None` on the desktop path.
pub(crate) fn current() -> Option<String> {
    ACTING_MEMBER_THREAD.with(|cell| cell.borrow().clone())
}

struct ThreadGuard(Option<String>);

impl ThreadGuard {
    fn set(member: Option<String>) -> Self {
        Self(ACTING_MEMBER_THREAD.with(|cell| cell.replace(member)))
    }
}

impl Drop for ThreadGuard {
    fn drop(&mut self) {
        ACTING_MEMBER_THREAD.with(|cell| *cell.borrow_mut() = self.0.take());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_thread_binds_and_restores_even_when_nested() {
        assert_eq!(current(), None);
        let outer = scope_thread(Some("alice".to_string()), || {
            let nested = scope_thread(Some("bob".to_string()), current);
            assert_eq!(nested, Some("bob".to_string()));
            // restored to the outer binding after the nested scope
            current()
        });
        assert_eq!(outer, Some("alice".to_string()));
        // fully restored to unbound after the outer scope
        assert_eq!(current(), None);
    }
}
