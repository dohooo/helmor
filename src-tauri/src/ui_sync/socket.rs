use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager, Runtime};

use super::{events::UiMutationEnvelope, manager::UiSyncManager};

const SOCKET_FILENAME: &str = "ui-sync.sock";

pub fn socket_path() -> Result<PathBuf> {
    Ok(crate::data_dir::run_dir()?.join(SOCKET_FILENAME))
}

pub fn start_listener<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    #[cfg(unix)]
    {
        let socket_path = socket_path()?;
        if socket_path.exists() {
            let _ = std::fs::remove_file(&socket_path);
        }

        let listener = std::os::unix::net::UnixListener::bind(&socket_path)
            .with_context(|| format!("Failed to bind UI sync socket {}", socket_path.display()))?;
        listener
            .set_nonblocking(false)
            .context("Failed to configure UI sync socket")?;

        std::thread::Builder::new()
            .name("ui-sync-listener".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else {
                        continue;
                    };

                    let mut line = String::new();
                    let read_result = {
                        let mut reader = BufReader::new(&mut stream);
                        reader.read_line(&mut line)
                    };

                    let response = match read_result {
                        Ok(0) => br#"{"ok":false,"error":"empty request"}"#.as_slice(),
                        Ok(_) => match serde_json::from_str::<UiMutationEnvelope>(&line) {
                            Ok(envelope) if envelope.version == UiMutationEnvelope::VERSION => {
                                let manager = app.state::<UiSyncManager>();
                                manager.publish(envelope.event);
                                br#"{"ok":true}"#.as_slice()
                            }
                            Ok(_) => br#"{"ok":false,"error":"unsupported version"}"#.as_slice(),
                            Err(_) => br#"{"ok":false,"error":"invalid payload"}"#.as_slice(),
                        },
                        Err(_) => br#"{"ok":false,"error":"read failed"}"#.as_slice(),
                    };

                    let _ = stream.write_all(response);
                    let _ = stream.write_all(b"\n");
                    let _ = stream.flush();
                }
            })
            .context("Failed to spawn UI sync socket listener")?;

        Ok(())
    }

    #[cfg(not(unix))]
    {
        let _ = app;
        Ok(())
    }
}

pub fn notify_running_app(event: super::events::UiMutationEvent) -> Result<bool> {
    #[cfg(unix)]
    {
        let socket_path = socket_path()?;
        if !socket_path.exists() {
            return Ok(false);
        }

        let mut stream = match std::os::unix::net::UnixStream::connect(&socket_path) {
            Ok(stream) => stream,
            Err(_) => return Ok(false),
        };

        let payload = serde_json::to_string(&UiMutationEnvelope::new(event))
            .context("Failed to serialize UI mutation envelope")?;
        stream
            .write_all(payload.as_bytes())
            .context("Failed to write UI sync payload")?;
        stream
            .write_all(b"\n")
            .context("Failed to terminate UI sync payload")?;
        stream.flush().context("Failed to flush UI sync payload")?;

        let mut reader = BufReader::new(stream);
        let mut response = String::new();
        reader
            .read_line(&mut response)
            .context("Failed to read UI sync response")?;

        let ok = serde_json::from_str::<serde_json::Value>(&response)
            .ok()
            .and_then(|value| value.get("ok").and_then(|ok| ok.as_bool()))
            .unwrap_or(false);

        Ok(ok)
    }

    #[cfg(not(unix))]
    {
        let _ = event;
        Ok(false)
    }
}

pub fn is_listener_running() -> bool {
    #[cfg(unix)]
    {
        let Ok(socket_path) = socket_path() else {
            return false;
        };
        if !socket_path.exists() {
            return false;
        }

        std::os::unix::net::UnixStream::connect(socket_path).is_ok()
    }

    #[cfg(not(unix))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_dir::TEST_ENV_LOCK;
    use crate::ui_sync::events::UiMutationEvent;

    #[test]
    fn socket_path_uses_run_dir() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", dir.path());

        let path = socket_path().unwrap();
        assert!(path.ends_with("run/ui-sync.sock"));
    }

    #[test]
    fn envelope_parser_accepts_current_version() {
        let line = serde_json::to_string(&UiMutationEnvelope::new(
            UiMutationEvent::WorkspaceListChanged,
        ))
        .unwrap();
        let envelope: UiMutationEnvelope = serde_json::from_str(&line).unwrap();
        assert_eq!(envelope.version, UiMutationEnvelope::VERSION);
    }

    #[test]
    fn envelope_parser_rejects_unsupported_version() {
        // A v2 payload should still parse (forward-compat), but the version
        // check at the call site is what gates publishing. Verify both halves.
        let line = r#"{"version":99,"event":{"type":"workspaceListChanged"}}"#;
        let envelope: UiMutationEnvelope = serde_json::from_str(line).unwrap();
        assert_ne!(envelope.version, UiMutationEnvelope::VERSION);
    }

    #[test]
    fn envelope_parser_rejects_garbage_json() {
        let result = serde_json::from_str::<UiMutationEnvelope>("not json");
        assert!(result.is_err());
    }

    #[test]
    fn envelope_parser_rejects_unknown_event_type() {
        let line = r#"{"version":1,"event":{"type":"madeUpEvent"}}"#;
        let result = serde_json::from_str::<UiMutationEnvelope>(line);
        assert!(result.is_err());
    }

    #[test]
    fn is_listener_running_returns_false_without_socket() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", dir.path());
        // Socket file has not been created — listener must report false.
        assert!(!is_listener_running());
    }

    #[test]
    fn notify_running_app_returns_false_without_socket() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", dir.path());
        let result = notify_running_app(UiMutationEvent::WorkspaceListChanged).unwrap();
        assert!(!result, "with no socket the call must succeed with false");
    }
}
