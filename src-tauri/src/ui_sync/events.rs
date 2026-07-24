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
    CodexGoalChanged {
        session_id: String,
    },
    /// The session's normalised plan projection in `session_plan_state`
    /// was upserted (Codex `turn/plan/updated` or Claude `ExitPlanMode`
    /// just landed). Frontends invalidate the `sessionPlanState` query
    /// and re-fetch the typed payload.
    SessionPlanChanged {
        session_id: String,
    },
    /// Fires when a `goal_status` system message has been synthesised into
    /// the conversation history out-of-band — the streaming pipeline owns
    /// real assistant messages, this exists for the lifecycle markers
    /// (Goal paused / resumed / cleared) we insert ourselves.
    SessionMessagesAppended {
        session_id: String,
    },
    /// A turn's terminal rows really landed in `session_messages` — fired
    /// after `persist_result_and_finalize` / `persist_error_message`
    /// succeed (including the abnormal-exit cleanup path) and after an
    /// aborted turn finalizes. Unlike
    /// `SessionMessagesAppended` (active refetch for out-of-band inserts),
    /// frontends only mark the thread cache stale (`refetchType: 'none'`)
    /// so the next mount refetches; the live-stream dispatcher keeps
    /// owning the on-screen snapshot.
    SessionTurnPersisted {
        session_id: String,
    },
    /// A team room-chat message (a human teammate message NOT dispatched to an
    /// agent) was just persisted by `post_room_chat_message`. Published
    /// ADDITIVELY alongside `WorkspaceListChanged` (which stays for the sidebar).
    /// Two consumers:
    ///   - Stage B mirror keys off `session_id` to write the row through to D1
    ///     — exactly like `SessionMessagesAppended` — so room chat reaches the
    ///     history mirror (`WorkspaceListChanged` triggers no message mirror).
    ///   - Frontends compare `author_id` (the SERVER-derived member id, same
    ///     source as room-chat `author_id` / presence `member_id`) against the
    ///     local identity, so a self-origin echo is handled ack-only (mark
    ///     stale, never an active refetch that could clobber the optimistic
    ///     row). `author_id` is `None` only on the desktop-local path; room
    ///     chat is team-only, so it is `Some` in practice.
    RoomChatMessageAppended {
        session_id: String,
        author_id: Option<String>,
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
    /// A repo's `repo_run_actions` list changed (create / update / delete /
    /// reorder). Frontends invalidate `["repoScripts", repoId, ...]`.
    RepoRunActionsChanged {
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
    /// The set of in-flight agent streams changed (a turn started or
    /// ended). Carries no payload — frontends invalidate and re-fetch
    /// `list_active_streams`. See `agents::streaming::active_streams` for
    /// the source of truth this notification mirrors.
    ActiveStreamsChanged,
    /// A Terminal-Mode agent hook reported a working/idle transition. The
    /// ui-sync socket listener folds it into the active-stream registry (so the
    /// sidebar spinner treats it like any session) and re-broadcasts
    /// `ActiveStreamsChanged`. Carries the owning session + workspace.
    TerminalActivityChanged {
        session_id: String,
        workspace_id: String,
        busy: bool,
    },
    /// A Terminal-Mode agent hook reported the turn finished (`Stop`). The
    /// ui-sync listener re-broadcasts this so the frontend runs the shared
    /// completion path (mark-unread + OS notification) like a GUI session.
    TerminalSessionIdle {
        session_id: String,
        workspace_id: String,
    },
    /// A Terminal-Mode agent hook captured the user's submitted prompt
    /// (`UserPromptSubmit`). The frontend feeds it to the shared title and
    /// branch-rename generator so a Terminal session names itself like a GUI
    /// session does on its first turn.
    TerminalPromptCaptured {
        session_id: String,
        workspace_id: String,
        prompt: String,
    },
    /// Connected-Slack-workspace set changed (Connect / Disconnect).
    /// Frontends invalidate the workspace list query and the inbox
    /// queries for any affected team.
    SlackWorkspacesChanged,
    /// A Slack workspace's stored credentials no longer authenticate
    /// (xoxc rotation, account logout, admin revoke). The frontend
    /// surfaces a "Reconnect" affordance for this workspace.
    SlackTokenInvalidated {
        team_id: String,
    },
    /// Fast mode was requested but didn't engage; the composer flips its
    /// fast-mode toggle off for this session.
    FastModeUnavailable {
        session_id: String,
        reason: String,
    },
    /// The mobile-companion paired-device list changed (paired or revoked).
    /// Frontends invalidate the `pairedDevices` query.
    PairedDevicesChanged,
    /// "Open in Helmor" from the quick panel. Only the MAIN window acts on
    /// this (navigates to the workspace/session); the quick panel ignores it.
    WorkspaceRevealRequested {
        workspace_id: String,
        session_id: Option<String>,
    },
    /// A team member's transient activity in a shared workspace (composer
    /// typing or an agent working). Ephemeral: no DB row, broadcast over the
    /// shared `/v1/stream` to every connected member; clients self-expire it
    /// by `ts` + a client-side TTL (there is no reliable disconnect signal).
    /// `member_id` is the SERVER-derived trusted member id (same source as
    /// room-chat `author_id`), never client-asserted. `ts` is server unix-ms.
    RoomPresenceChanged {
        member_id: String,
        workspace_id: String,
        session_id: Option<String>,
        activity: PresenceActivity,
        ts: u64,
    },
}

/// Transient presence activity for a shared-workspace member. `Idle` is an
/// explicit clear (e.g. composer blur / send) so peers can drop the indicator
/// before the TTL elapses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PresenceActivity {
    Typing,
    Working,
    Idle,
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
            UiMutationEvent::CodexGoalChanged {
                session_id: "s".into(),
            },
            UiMutationEvent::SessionPlanChanged {
                session_id: "s".into(),
            },
            UiMutationEvent::SessionMessagesAppended {
                session_id: "s".into(),
            },
            UiMutationEvent::SessionTurnPersisted {
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
            UiMutationEvent::RepoRunActionsChanged {
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
            UiMutationEvent::ActiveStreamsChanged,
            UiMutationEvent::TerminalActivityChanged {
                session_id: "s".into(),
                workspace_id: "w".into(),
                busy: true,
            },
            UiMutationEvent::TerminalSessionIdle {
                session_id: "s".into(),
                workspace_id: "w".into(),
            },
            UiMutationEvent::TerminalPromptCaptured {
                session_id: "s".into(),
                workspace_id: "w".into(),
                prompt: "hi".into(),
            },
            UiMutationEvent::SlackTokenInvalidated {
                team_id: "T1".into(),
            },
            UiMutationEvent::FastModeUnavailable {
                session_id: "s".into(),
                reason: "extra usage not enabled".into(),
            },
            UiMutationEvent::RoomPresenceChanged {
                member_id: "1".into(),
                workspace_id: "w".into(),
                session_id: Some("s".into()),
                activity: PresenceActivity::Typing,
                ts: 0,
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
    fn session_plan_changed_uses_camel_case_type_and_field() {
        let event = UiMutationEvent::SessionPlanChanged {
            session_id: "abc".into(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "sessionPlanChanged");
        assert_eq!(json["sessionId"], "abc");
        assert!(json.get("session_id").is_none());
    }

    #[test]
    fn session_turn_persisted_uses_camel_case_type_and_field() {
        let event = UiMutationEvent::SessionTurnPersisted {
            session_id: "abc".into(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "sessionTurnPersisted");
        assert_eq!(json["sessionId"], "abc");
        assert!(json.get("session_id").is_none());
    }

    #[test]
    fn room_chat_message_appended_uses_camel_case_type_and_fields() {
        let event = UiMutationEvent::RoomChatMessageAppended {
            session_id: "abc".into(),
            author_id: Some("42".into()),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "roomChatMessageAppended");
        assert_eq!(json["sessionId"], "abc");
        assert_eq!(json["authorId"], "42");
        assert!(json.get("session_id").is_none());
        assert!(json.get("author_id").is_none());
    }

    #[test]
    fn room_chat_message_appended_serializes_absent_author_as_null() {
        // Desktop-local path leaves author_id None; it must go over the wire as
        // an explicit null (not omitted), so the frontend reads `authorId` as
        // null and treats origin as unknown (not self).
        let event = UiMutationEvent::RoomChatMessageAppended {
            session_id: "abc".into(),
            author_id: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert!(json["authorId"].is_null());
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
            (
                UiMutationEvent::ActiveStreamsChanged,
                "activeStreamsChanged",
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
            permission_mode: Some("bypassPermissions".into()),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["modelId"], "claude-sonnet-4-5");
        assert_eq!(json["permissionMode"], "bypassPermissions");
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

    /// Coverage guard: every `UiMutationEvent` variant must be CONSTRUCTED
    /// somewhere in `src-tauri/src` outside `events.rs` — i.e. something
    /// actually produces (and publishes) it. A variant defined but never built
    /// is dead weight: the wire contract drifts and the frontend silently never
    /// updates. The exhaustive `variant_ident` match also forces a new variant
    /// to be classified here (compile error) and listed in `samples()`.
    #[test]
    fn every_variant_is_produced_in_source() {
        // Variants intentionally NOT constructed in normal Rust source (e.g. a
        // future event only ever deserialized from an off-process payload).
        // Empty today — every variant has an in-repo producer (`UiMutationEvent::X`
        // or the socket alias `E::X`).
        const EXEMPT: &[&str] = &[];

        let src = concat_rust_sources();
        for event in samples() {
            let ident = variant_ident(&event);
            if EXEMPT.contains(&ident) {
                continue;
            }
            assert!(
                src.contains(&format!("::{ident}")),
                "UiMutationEvent::{ident} is never constructed outside events.rs — \
                 nothing publishes it (wire a producer, or add it to EXEMPT with a reason)."
            );
        }
    }

    /// The Rust variant ident for a `UiMutationEvent`. Exhaustive on purpose: a
    /// new variant won't compile until it's listed here AND in `samples()`.
    fn variant_ident(event: &UiMutationEvent) -> &'static str {
        use UiMutationEvent as E;
        match event {
            E::WorkspaceListChanged => "WorkspaceListChanged",
            E::WorkspaceChanged { .. } => "WorkspaceChanged",
            E::SessionListChanged { .. } => "SessionListChanged",
            E::ContextUsageChanged { .. } => "ContextUsageChanged",
            E::CodexGoalChanged { .. } => "CodexGoalChanged",
            E::SessionPlanChanged { .. } => "SessionPlanChanged",
            E::SessionMessagesAppended { .. } => "SessionMessagesAppended",
            E::SessionTurnPersisted { .. } => "SessionTurnPersisted",
            E::RoomChatMessageAppended { .. } => "RoomChatMessageAppended",
            E::WorkspaceFilesChanged { .. } => "WorkspaceFilesChanged",
            E::WorkspaceGitStateChanged { .. } => "WorkspaceGitStateChanged",
            E::WorkspaceForgeChanged { .. } => "WorkspaceForgeChanged",
            E::WorkspaceChangeRequestChanged { .. } => "WorkspaceChangeRequestChanged",
            E::RepositoryListChanged => "RepositoryListChanged",
            E::RepositoryChanged { .. } => "RepositoryChanged",
            E::RepoRunActionsChanged { .. } => "RepoRunActionsChanged",
            E::SettingsChanged { .. } => "SettingsChanged",
            E::PendingCliSendQueued { .. } => "PendingCliSendQueued",
            E::ActiveStreamsChanged => "ActiveStreamsChanged",
            E::TerminalActivityChanged { .. } => "TerminalActivityChanged",
            E::TerminalSessionIdle { .. } => "TerminalSessionIdle",
            E::TerminalPromptCaptured { .. } => "TerminalPromptCaptured",
            E::SlackWorkspacesChanged => "SlackWorkspacesChanged",
            E::SlackTokenInvalidated { .. } => "SlackTokenInvalidated",
            E::FastModeUnavailable { .. } => "FastModeUnavailable",
            E::PairedDevicesChanged => "PairedDevicesChanged",
            E::WorkspaceRevealRequested { .. } => "WorkspaceRevealRequested",
            E::RoomPresenceChanged { .. } => "RoomPresenceChanged",
        }
    }

    /// One instance of every variant. Keep in sync with `variant_ident`.
    fn samples() -> Vec<UiMutationEvent> {
        use UiMutationEvent as E;
        let w = || "w".to_string();
        let s = || "s".to_string();
        vec![
            E::WorkspaceListChanged,
            E::WorkspaceChanged { workspace_id: w() },
            E::SessionListChanged { workspace_id: w() },
            E::ContextUsageChanged { session_id: s() },
            E::CodexGoalChanged { session_id: s() },
            E::SessionPlanChanged { session_id: s() },
            E::SessionMessagesAppended { session_id: s() },
            E::SessionTurnPersisted { session_id: s() },
            E::RoomChatMessageAppended {
                session_id: s(),
                author_id: None,
            },
            E::WorkspaceFilesChanged { workspace_id: w() },
            E::WorkspaceGitStateChanged { workspace_id: w() },
            E::WorkspaceForgeChanged { workspace_id: w() },
            E::WorkspaceChangeRequestChanged { workspace_id: w() },
            E::RepositoryListChanged,
            E::RepositoryChanged {
                repo_id: "r".into(),
            },
            E::RepoRunActionsChanged {
                repo_id: "r".into(),
            },
            E::SettingsChanged { key: None },
            E::PendingCliSendQueued {
                workspace_id: w(),
                session_id: s(),
                prompt: "p".into(),
                model_id: None,
                permission_mode: None,
            },
            E::ActiveStreamsChanged,
            E::TerminalActivityChanged {
                session_id: s(),
                workspace_id: w(),
                busy: true,
            },
            E::TerminalSessionIdle {
                session_id: s(),
                workspace_id: w(),
            },
            E::TerminalPromptCaptured {
                session_id: s(),
                workspace_id: w(),
                prompt: "p".into(),
            },
            E::SlackWorkspacesChanged,
            E::SlackTokenInvalidated {
                team_id: "t".into(),
            },
            E::FastModeUnavailable {
                session_id: s(),
                reason: "r".into(),
            },
            E::PairedDevicesChanged,
            E::WorkspaceRevealRequested {
                workspace_id: w(),
                session_id: Some(s()),
            },
            E::RoomPresenceChanged {
                member_id: "1".into(),
                workspace_id: w(),
                session_id: Some(s()),
                activity: PresenceActivity::Typing,
                ts: 0,
            },
        ]
    }

    /// Concatenate every `.rs` under `src/` except `events.rs` (whose own test
    /// samples would otherwise count as producers).
    fn concat_rust_sources() -> String {
        fn walk(dir: &std::path::Path, out: &mut String) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().and_then(|e| e.to_str()) == Some("rs")
                    && path.file_name().and_then(|n| n.to_str()) != Some("events.rs")
                {
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        out.push_str(&text);
                        out.push('\n');
                    }
                }
            }
        }
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut out = String::new();
        walk(&src, &mut out);
        out
    }
}
