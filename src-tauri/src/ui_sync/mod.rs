mod events;
mod manager;
mod socket;

use tauri::{ipc::Channel, AppHandle, Manager, Runtime};

pub use events::{UiMutationEnvelope, UiMutationEvent};
pub use manager::UiSyncManager;
pub use socket::{is_listener_running, notify_running_app, socket_path, start_listener};

pub fn publish<R: Runtime>(app: &AppHandle<R>, event: UiMutationEvent) {
    let manager = app.state::<UiSyncManager>();
    manager.publish(event);
}

#[tauri::command]
pub fn subscribe_ui_mutations(
    manager: tauri::State<'_, UiSyncManager>,
    subscription_id: String,
    on_event: Channel<UiMutationEvent>,
) {
    manager.subscribe(subscription_id, on_event);
}

#[tauri::command]
pub fn unsubscribe_ui_mutations(manager: tauri::State<'_, UiSyncManager>, subscription_id: String) {
    manager.unsubscribe(&subscription_id);
}
