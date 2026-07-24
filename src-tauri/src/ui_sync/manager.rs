use std::sync::Mutex;

use tauri::ipc::Channel;

use super::events::UiMutationEvent;

#[derive(Default)]
pub struct UiSyncManager {
    subscribers: Mutex<Vec<UiSyncSubscriber>>,
}

struct UiSyncSubscriber {
    id: String,
    channel: Channel<UiMutationEvent>,
}

impl UiSyncManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe(&self, id: String, channel: Channel<UiMutationEvent>) {
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.retain(|subscriber| subscriber.id != id);
            subscribers.push(UiSyncSubscriber { id, channel });
        }
    }

    pub fn unsubscribe(&self, id: &str) {
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.retain(|subscriber| subscriber.id != id);
        }
    }

    pub fn publish(&self, event: UiMutationEvent) {
        let Ok(mut subscribers) = self.subscribers.lock() else {
            return;
        };

        subscribers.retain(|subscriber| subscriber.channel.send(event.clone()).is_ok());
    }

    #[cfg(test)]
    pub(super) fn subscriber_count(&self) -> usize {
        self.subscribers.lock().map(|s| s.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_manager_starts_with_no_subscribers() {
        let manager = UiSyncManager::new();
        assert_eq!(manager.subscriber_count(), 0);
    }

    #[test]
    fn publish_with_no_subscribers_is_a_noop() {
        let manager = UiSyncManager::new();
        manager.publish(UiMutationEvent::WorkspaceListChanged);
        assert_eq!(manager.subscriber_count(), 0);
    }

    #[test]
    fn unsubscribe_missing_subscriber_is_a_noop() {
        let manager = UiSyncManager::new();
        manager.unsubscribe("missing");
        assert_eq!(manager.subscriber_count(), 0);
    }

    #[test]
    fn default_manager_matches_new() {
        let default_manager = UiSyncManager::default();
        let new_manager = UiSyncManager::new();
        assert_eq!(
            default_manager.subscriber_count(),
            new_manager.subscriber_count()
        );
    }

    /// The broadcast contract behind the companion `/v1/stream`: a `publish`
    /// reaches every subscribed channel as the serialized (camelCase) event.
    /// Exercises `RoomPresenceChanged` end-to-end through the same `Channel`
    /// path `companion/stream.rs::ndjson_channel` uses to feed the SSE body.
    #[test]
    fn publish_delivers_serialized_event_to_each_subscriber() {
        use std::sync::Arc;
        use tauri::ipc::InvokeResponseBody;

        use crate::ui_sync::PresenceActivity;

        let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let capture = |sink: Arc<Mutex<Vec<String>>>| {
            Channel::new(move |body: InvokeResponseBody| {
                let line = match body {
                    InvokeResponseBody::Json(json) => json,
                    InvokeResponseBody::Raw(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                };
                if let Ok(mut sink) = sink.lock() {
                    sink.push(line);
                }
                Ok(())
            })
        };

        let manager = UiSyncManager::new();
        manager.subscribe("a".into(), capture(received.clone()));
        manager.subscribe("b".into(), capture(received.clone()));

        manager.publish(UiMutationEvent::RoomPresenceChanged {
            member_id: "42".into(),
            workspace_id: "w1".into(),
            session_id: Some("s1".into()),
            activity: PresenceActivity::Typing,
            ts: 7,
        });

        let lines = received.lock().unwrap();
        assert_eq!(lines.len(), 2, "both subscribers must receive the event");
        for line in lines.iter() {
            assert!(line.contains("\"type\":\"roomPresenceChanged\""), "{line}");
            assert!(line.contains("\"memberId\":\"42\""), "{line}");
            assert!(line.contains("\"activity\":\"typing\""), "{line}");
            assert!(line.contains("\"ts\":7"), "{line}");
            assert!(
                !line.contains('_'),
                "wire payload must be camelCase: {line}"
            );
        }
    }
}
