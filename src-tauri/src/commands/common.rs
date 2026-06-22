use crate::error::CommandError;

pub(super) type CmdResult<T> = Result<T, CommandError>;

pub(super) async fn run_blocking<F, T>(f: F) -> CmdResult<T>
where
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
    T: Send + 'static,
{
    // Bridge the acting member across the async→blocking boundary: read the
    // dispatcher's async task-local here (still in the async context) and re-bind
    // it as a thread-local inside the blocking closure so the forge layer can
    // select that member's credentials. `None` on the desktop path (no scope).
    let acting = crate::forge::acting_member::current_async();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::forge::acting_member::scope_thread(acting, f)
    })
    .await
    .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))?;
    Ok(result?)
}
