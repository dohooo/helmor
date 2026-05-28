//! Wire shapes for the sidecar → Rust reverse IPC.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRequest {
    pub callback_id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct HostResponse {
    #[serde(rename = "type")]
    pub event_type: &'static str,
    #[serde(rename = "callbackId")]
    pub callback_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl HostResponse {
    pub fn success(callback_id: String, value: Value) -> Self {
        Self {
            event_type: "hostResponse",
            callback_id,
            ok: Some(value),
            error: None,
        }
    }

    pub fn failure(callback_id: String, message: String) -> Self {
        Self {
            event_type: "hostResponse",
            callback_id,
            ok: None,
            error: Some(message),
        }
    }
}
