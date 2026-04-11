use crate::error::CommandError;

pub(super) type CmdResult<T> = Result<T, CommandError>;

pub(super) async fn run_blocking<F, T>(f: F) -> CmdResult<T>
where
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
    T: Send + 'static,
{
    let result = tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))?;
    Ok(result?)
}
