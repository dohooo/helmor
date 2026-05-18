//! Server-side push channel.
//!
//! Server handlers (or any background task on the server) call
//! `notify` to push a JSON-RPC notification — a request with no
//! `id` — up the pipe to the connected client. The trait is
//! `Send + Sync` so an `Arc<dyn Notifier>` can be stashed and the
//! emission happens from a background thread.

use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::remote::codec::write_frame;
use crate::remote::protocol::{JsonRpcId, JsonRpcRequest};

/// Server-side push channel — the inverse of the client's
/// [`crate::remote::client::NotificationSubscription`]. Server
/// handlers (or any background task on the server) call `notify`
/// to push a JSON-RPC notification (request with no `id`) up the
/// pipe.
///
/// The spike's binary uses [`StdoutNotifier`] to write framed
/// notifications onto its stdout, sharing the lock with the
/// response writer. Tests use [`NoopNotifier`] (or capture into a
/// channel).
pub trait Notifier: Send + Sync {
    /// Push a notification with the given method name + params.
    /// Errors are logged inside the impl — the caller has no
    /// recovery path beyond "ignore" since notifications are
    /// fire-and-forget by definition.
    fn notify(&self, method: &str, params: Value);
}

/// Default no-op notifier. Used by [`super::ServerContext::new`]
/// and by loopback tests that don't care about server-pushed
/// events.
pub struct NoopNotifier;

impl Notifier for NoopNotifier {
    fn notify(&self, _method: &str, _params: Value) {}
}

/// Notifier that writes framed JSON-RPC notifications to a shared
/// writer (typically the binary's stdout). The lock guarantees a
/// response frame and a notification frame can't interleave
/// mid-write.
///
/// `helmor-server`'s main loop owns one of these and passes a clone
/// to the `ServerContext`; future handlers that want to emit events
/// (agent stream, terminal output, file watcher) hold an
/// `Arc<dyn Notifier>` and call `notify` from their own threads.
pub struct StdoutNotifier {
    /// Mutex around the writer keeps notification frames atomic with
    /// respect to response frames. The binary's main loop *also*
    /// writes through a `Mutex<W>` on the same handle — design rule
    /// is "all writes to the pipe go through one mutex".
    writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
}

impl StdoutNotifier {
    pub fn new(writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>) -> Self {
        Self { writer }
    }
}

impl Notifier for StdoutNotifier {
    fn notify(&self, method: &str, params: Value) {
        // Notifications are JSON-RPC requests with no id. The framer
        // serialises them like any other request.
        let request = JsonRpcRequest::new(method, params, JsonRpcId::Null);
        let mut writer = match self.writer.lock() {
            Ok(w) => w,
            Err(err) => {
                tracing::error!(
                    error = %err,
                    "remote-runner: notifier writer mutex poisoned"
                );
                return;
            }
        };
        if let Err(err) = write_frame(&mut *writer, &request) {
            tracing::warn!(
                method = %method,
                error = %err,
                "remote-runner: failed to write notification frame"
            );
        }
    }
}
