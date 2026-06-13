//! Per-session fan-out of live agent-stream events to *watchers*.
//!
//! The client that calls `send_agent_message_stream` renders the turn from
//! its own per-invocation `Channel` (the direct, point-to-point path — left
//! untouched). This hub is the SECOND path: any other connected client
//! (a second desktop window, or the mobile companion over HTTP/NDJSON) can
//! `subscribe_session_stream` and receive the SAME `AgentStreamEvent`s, so it
//! mirrors the live turn in real time instead of only seeing it after reload.
//!
//! Demand-driven by design: `publish` is gated on a single relaxed atomic
//! load, so a desktop with no watcher (the common case) pays only that load
//! per event — no clone, no serialize, no lock. The expensive `event.clone()`
//! happens only when at least one watcher is attached to that session.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use tauri::ipc::Channel;

use crate::agents::AgentStreamEvent;

struct Subscriber {
    id: String,
    channel: Channel<AgentStreamEvent>,
}

#[derive(Default)]
struct SessionEntry {
    subscribers: Vec<Subscriber>,
    /// Last render-relevant event (`Update` / `StreamingPartial`), replayed to
    /// a watcher that attaches mid-turn so it catches up immediately instead of
    /// waiting for the next delta. Cleared on terminal events.
    last_render: Option<AgentStreamEvent>,
}

/// Tauri-managed registry of session watchers. Shared by the native
/// `subscribe_session_stream` command and the companion HTTP bridge — both go
/// through the same instance, which is what makes mirroring symmetric across
/// desktop and mobile.
#[derive(Default)]
pub struct SessionStreamHub {
    inner: Mutex<HashMap<String, SessionEntry>>,
    /// Total watcher count across all sessions. Lets `publish` early-out with a
    /// single relaxed load when nobody is watching.
    total: AtomicUsize,
}

impl SessionStreamHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Attach a watcher to `session_id`. Immediately replays the last
    /// render-relevant event (if any) so a mid-turn joiner isn't blank until
    /// the next delta.
    pub fn subscribe(
        &self,
        session_id: String,
        subscription_id: String,
        channel: Channel<AgentStreamEvent>,
    ) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(session_id).or_default();
        if let Some(event) = &entry.last_render {
            let _ = channel.send(event.clone());
        }
        entry.subscribers.push(Subscriber {
            id: subscription_id,
            channel,
        });
        self.total.fetch_add(1, Ordering::Relaxed);
    }

    /// Detach a watcher. Drops the whole session entry (and its replay cache)
    /// once the last watcher leaves, so no stale state lingers between turns.
    pub fn unsubscribe(&self, session_id: &str, subscription_id: &str) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get_mut(session_id) {
            let before = entry.subscribers.len();
            entry.subscribers.retain(|s| s.id != subscription_id);
            let removed = before - entry.subscribers.len();
            if removed > 0 {
                self.total.fetch_sub(removed, Ordering::Relaxed);
            }
            if entry.subscribers.is_empty() {
                map.remove(session_id);
            }
        }
    }

    /// Cheap "is anyone watching anything" check — a single relaxed load.
    /// Gates the streaming hot path so the no-watcher case is effectively free.
    pub fn any_subscribers(&self) -> bool {
        self.total.load(Ordering::Relaxed) > 0
    }

    /// Fan `event` out to every watcher of `session_id`. No-op (no clone, no
    /// lock) when nobody is watching anywhere.
    pub fn publish(&self, session_id: &str, event: &AgentStreamEvent) {
        if !self.any_subscribers() {
            return;
        }
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = map.get_mut(session_id) else {
            return;
        };
        match event {
            AgentStreamEvent::Update { .. } | AgentStreamEvent::StreamingPartial { .. } => {
                entry.last_render = Some(event.clone());
            }
            AgentStreamEvent::Done { .. }
            | AgentStreamEvent::Aborted { .. }
            | AgentStreamEvent::Error { .. } => {
                entry.last_render = None;
            }
            _ => {}
        }
        let mut dropped = 0;
        entry.subscribers.retain(|s| {
            let ok = s.channel.send(event.clone()).is_ok();
            if !ok {
                dropped += 1;
            }
            ok
        });
        if dropped > 0 {
            self.total.fetch_sub(dropped, Ordering::Relaxed);
        }
        if entry.subscribers.is_empty() {
            map.remove(session_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update_event(text: &str) -> AgentStreamEvent {
        use crate::pipeline::types::{
            ExtendedMessagePart, MessagePart, MessageRole, ThreadMessageLike,
        };
        AgentStreamEvent::Update {
            messages: vec![ThreadMessageLike {
                role: MessageRole::Assistant,
                id: Some(text.to_string()),
                created_at: None,
                content: vec![ExtendedMessagePart::Basic(MessagePart::Text {
                    id: text.to_string(),
                    text: text.to_string(),
                })],
                status: None,
                streaming: None,
                source: None,
            }],
        }
    }

    #[test]
    fn idle_publish_is_noop_without_subscribers() {
        let hub = SessionStreamHub::new();
        assert!(!hub.any_subscribers());
        // Must not panic / allocate a session entry when nobody is watching.
        hub.publish("s1", &update_event("a"));
        assert!(!hub.any_subscribers());
    }

    #[test]
    fn unsubscribe_decrements_and_drops_entry() {
        let hub = SessionStreamHub::new();
        let channel = Channel::new(|_| Ok(()));
        hub.subscribe("s1".into(), "sub1".into(), channel);
        assert!(hub.any_subscribers());
        hub.unsubscribe("s1", "sub1");
        assert!(!hub.any_subscribers());
        // Second unsubscribe is a harmless no-op.
        hub.unsubscribe("s1", "sub1");
        assert!(!hub.any_subscribers());
    }

    #[test]
    fn replays_last_render_on_subscribe() {
        let hub = SessionStreamHub::new();
        // Prime a subscriber so publish caches the last render event.
        let primer = Channel::new(|_| Ok(()));
        hub.subscribe("s1".into(), "primer".into(), primer);
        hub.publish("s1", &update_event("hello"));

        // A late joiner should receive the cached event immediately.
        let received = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = received.clone();
        let late = Channel::new(move |_| {
            seen.fetch_add(1, Ordering::Relaxed);
            Ok(())
        });
        hub.subscribe("s1".into(), "late".into(), late);
        assert_eq!(received.load(Ordering::Relaxed), 1);
    }
}
