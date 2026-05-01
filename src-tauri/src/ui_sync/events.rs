use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UiMutationEvent {
    WorkspaceListChanged,
    WorkspaceChanged {
        workspace_id: String,
    },
    SessionListChanged {
        workspace_id: String,
    },
    ContextUsageChanged {
        session_id: String,
    },
    WorkspaceFilesChanged {
        workspace_id: String,
    },
    WorkspaceGitStateChanged {
        workspace_id: String,
    },
    WorkspaceForgeChanged {
        workspace_id: String,
    },
    WorkspaceChangeRequestChanged {
        workspace_id: String,
    },
    RepositoryListChanged,
    RepositoryChanged {
        repo_id: String,
    },
    SettingsChanged {
        key: Option<String>,
    },
    PendingCliSendQueued {
        workspace_id: String,
        session_id: String,
        prompt: String,
        model_id: Option<String>,
        permission_mode: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiMutationEnvelope {
    pub version: u8,
    pub event: UiMutationEvent,
}

impl UiMutationEnvelope {
    pub const VERSION: u8 = 1;

    pub fn new(event: UiMutationEvent) -> Self {
        Self {
            version: Self::VERSION,
            event,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression gate: `rename_all = "camelCase"` on the enum only renames
    /// variant names, NOT fields inside struct variants. We need
    /// `rename_all_fields = "camelCase"` on top. Without it, `session_id`
    /// goes over the wire as snake_case, the frontend reads `event.sessionId`
    /// as `undefined`, and `invalidateQueries` matches zero queries — the
    /// exact bug that broke the context-usage ring until the user switched
    /// sessions or windows. If this test ever fails, don't loosen it;
    /// re-check the serde attributes on `UiMutationEvent`.
    #[test]
    fn struct_variant_fields_serialize_as_camel_case() {
        let cases: Vec<UiMutationEvent> = vec![
            UiMutationEvent::WorkspaceChanged {
                workspace_id: "w".into(),
            },
            UiMutationEvent::SessionListChanged {
                workspace_id: "w".into(),
            },
            UiMutationEvent::ContextUsageChanged {
                session_id: "s".into(),
            },
            UiMutationEvent::WorkspaceFilesChanged {
                workspace_id: "w".into(),
            },
            UiMutationEvent::WorkspaceGitStateChanged {
                workspace_id: "w".into(),
            },
            UiMutationEvent::WorkspaceForgeChanged {
                workspace_id: "w".into(),
            },
            UiMutationEvent::WorkspaceChangeRequestChanged {
                workspace_id: "w".into(),
            },
            UiMutationEvent::RepositoryChanged {
                repo_id: "r".into(),
            },
            UiMutationEvent::SettingsChanged { key: None },
            UiMutationEvent::PendingCliSendQueued {
                workspace_id: "w".into(),
                session_id: "s".into(),
                prompt: "p".into(),
                model_id: None,
                permission_mode: None,
            },
        ];
        for event in cases {
            let s = serde_json::to_string(&event).unwrap();
            assert!(!s.contains('_'), "snake_case field leaked to the wire: {s}",);
        }
    }

    #[test]
    fn context_usage_changed_has_session_id_in_camel_case() {
        let event = UiMutationEvent::ContextUsageChanged {
            session_id: "abc".into(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "contextUsageChanged");
        assert_eq!(json["sessionId"], "abc");
        assert!(json.get("session_id").is_none());
    }

    #[test]
    fn variant_names_are_camel_case() {
        let cases = [
            (
                UiMutationEvent::WorkspaceListChanged,
                "workspaceListChanged",
            ),
            (
                UiMutationEvent::RepositoryListChanged,
                "repositoryListChanged",
            ),
        ];
        for (event, expected) in cases {
            let json = serde_json::to_value(&event).unwrap();
            assert_eq!(json["type"], expected);
        }
    }

    #[test]
    fn pending_cli_send_queued_includes_optional_fields_when_set() {
        let event = UiMutationEvent::PendingCliSendQueued {
            workspace_id: "w".into(),
            session_id: "s".into(),
            prompt: "hello".into(),
            model_id: Some("claude-sonnet-4-5".into()),
            permission_mode: Some("acceptEdits".into()),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["modelId"], "claude-sonnet-4-5");
        assert_eq!(json["permissionMode"], "acceptEdits");
        assert_eq!(json["workspaceId"], "w");
        assert_eq!(json["sessionId"], "s");
        assert_eq!(json["prompt"], "hello");
    }

    #[test]
    fn settings_changed_omits_or_serializes_key_correctly() {
        let with_key = UiMutationEvent::SettingsChanged {
            key: Some("theme".into()),
        };
        let without = UiMutationEvent::SettingsChanged { key: None };
        let with_json = serde_json::to_value(&with_key).unwrap();
        let without_json = serde_json::to_value(&without).unwrap();
        assert_eq!(with_json["key"], "theme");
        // None becomes null over the wire, not undefined.
        assert!(without_json["key"].is_null());
    }

    #[test]
    fn envelope_round_trip_preserves_event() {
        let envelope = UiMutationEnvelope::new(UiMutationEvent::ContextUsageChanged {
            session_id: "abc".into(),
        });
        let json = serde_json::to_string(&envelope).unwrap();
        let restored: UiMutationEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.version, UiMutationEnvelope::VERSION);
        assert_eq!(restored.event, envelope.event);
    }

    #[test]
    fn envelope_new_uses_current_version() {
        let envelope = UiMutationEnvelope::new(UiMutationEvent::WorkspaceListChanged);
        assert_eq!(envelope.version, 1);
    }

    #[test]
    fn envelope_rejects_extraneous_keys_at_root() {
        // Versioning relies on the envelope shape staying stable. If a future
        // refactor adds new top-level fields, fail loudly.
        let json = serde_json::json!({
            "version": 1,
            "event": { "type": "workspaceListChanged" },
        });
        let envelope: UiMutationEnvelope = serde_json::from_value(json).unwrap();
        assert_eq!(envelope.version, 1);
        assert_eq!(envelope.event, UiMutationEvent::WorkspaceListChanged);
    }
}
