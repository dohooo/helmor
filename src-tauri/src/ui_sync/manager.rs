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
}
