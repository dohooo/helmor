//! Lightweight HTTP server that mirrors Tauri IPC commands for browser-based
//! frontend development.  Run with:
//!
//!   cargo run --bin helmor-dev-server --features dev-server
//!
//! Then start the Vite dev server (`pnpm run dev`) and open Chrome at
//! localhost:1420.  The frontend will detect the absence of the Tauri runtime
//! and call `/api/*` endpoints instead.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;

use helmor_lib::data_dir;
use helmor_lib::sidecar::ManagedSidecar;

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

struct AppState {
    sidecar: ManagedSidecar,
    /// Active stream receivers keyed by stream_id.
    streams:
        Mutex<HashMap<String, std::sync::mpsc::Receiver<helmor_lib::agents::AgentStreamEvent>>>,
}

type SharedState = Arc<AppState>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Convert an `anyhow::Error` into an HTTP 500 + JSON body.
fn cmd_err(e: anyhow::Error) -> impl IntoResponse {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": format!("{e:#}") })),
    )
}

// Generic query params for endpoints that take a single ID.
#[derive(serde::Deserialize)]
struct IdQuery {
    id: String,
}

#[derive(serde::Deserialize)]
struct PathQuery {
    path: String,
}

#[derive(serde::Deserialize)]
struct RootQuery {
    #[serde(alias = "workspaceRootPath")]
    root: String,
}

#[derive(serde::Deserialize)]
struct WriteBody {
    path: String,
    content: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameSessionBody {
    session_id: String,
    title: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSessionSettingsBody {
    session_id: String,
    effort_level: Option<String>,
    permission_mode: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetManualStatusBody {
    workspace_id: String,
    status: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTargetBranchBody {
    workspace_id: String,
    target_branch: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentStreamRequestBody {
    request: helmor_lib::agents::AgentSendRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopAgentStreamBody {
    request: StopAgentStreamInner,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopAgentStreamInner {
    session_id: String,
    provider: Option<String>,
}

#[derive(serde::Deserialize)]
struct StreamIdQuery {
    #[serde(alias = "streamId")]
    stream_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListSlashCommandsQuery {
    provider: String,
    working_directory: Option<String>,
    model_id: Option<String>,
}

// ---------------------------------------------------------------------------
// SSE stream wrapper
// ---------------------------------------------------------------------------

/// Wraps a `tokio::sync::mpsc::Receiver` as a `futures_core::Stream` for SSE.
struct SseEventStream {
    rx: tokio::sync::mpsc::Receiver<helmor_lib::agents::AgentStreamEvent>,
}

impl futures_core::Stream for SseEventStream {
    type Item = Result<Event, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(event)) => {
                let data = serde_json::to_string(&event).unwrap_or_default();
                Poll::Ready(Some(Ok(Event::default().data(data))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

mod handlers {
    use super::*;

    // --- workspace groups (read) -------------------------------------------

    pub async fn list_workspace_groups() -> impl IntoResponse {
        match helmor_lib::dev_api::list_workspace_groups() {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn get_workspace(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::get_workspace(&q.id) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn list_archived_workspaces() -> impl IntoResponse {
        match helmor_lib::dev_api::list_archived_workspaces() {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    // --- sessions / messages (read) ----------------------------------------

    pub async fn list_workspace_sessions(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::list_workspace_sessions(&q.id) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn list_session_thread_messages(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::list_session_thread_messages(&q.id) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn list_session_attachments(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::list_session_attachments(&q.id) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn list_hidden_sessions(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::list_hidden_sessions(&q.id) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    // --- repos / models / misc (read) --------------------------------------

    pub async fn list_repositories() -> impl IntoResponse {
        match helmor_lib::dev_api::list_repositories() {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn list_agent_model_sections() -> impl IntoResponse {
        Json(helmor_lib::dev_api::list_agent_model_sections())
    }

    pub async fn get_data_info() -> impl IntoResponse {
        match helmor_lib::dev_api::get_data_info() {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn get_app_settings() -> impl IntoResponse {
        match helmor_lib::dev_api::get_app_settings() {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn detect_installed_editors() -> impl IntoResponse {
        match helmor_lib::dev_api::detect_installed_editors() {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    // --- editor file operations (read/write) --------------------------------

    pub async fn read_editor_file(Query(q): Query<PathQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::read_editor_file(&q.path) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn write_editor_file(Json(body): Json<WriteBody>) -> impl IntoResponse {
        match helmor_lib::dev_api::write_editor_file(&body.path, &body.content) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn stat_editor_file(Query(q): Query<PathQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::stat_editor_file(&q.path) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn list_editor_files(Query(q): Query<RootQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::list_editor_files(&q.root) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn list_editor_files_with_content(Query(q): Query<RootQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::list_editor_files_with_content(&q.root) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn list_workspace_changes(Query(q): Query<RootQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::list_workspace_changes(&q.root) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn list_workspace_changes_with_content(
        Query(q): Query<RootQuery>,
    ) -> impl IntoResponse {
        match helmor_lib::dev_api::list_workspace_changes_with_content(&q.root) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    // --- session write operations ------------------------------------------

    pub async fn create_session(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::create_session(&q.id) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn delete_session(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::delete_session(&q.id) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn hide_session(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::hide_session(&q.id) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn unhide_session(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::unhide_session(&q.id) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn rename_session(Json(body): Json<RenameSessionBody>) -> impl IntoResponse {
        match helmor_lib::dev_api::rename_session(&body.session_id, &body.title) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn mark_session_read(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::mark_session_read(&q.id) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn update_session_settings(
        Json(body): Json<UpdateSessionSettingsBody>,
    ) -> impl IntoResponse {
        match helmor_lib::dev_api::update_session_settings(
            &body.session_id,
            body.effort_level.as_deref(),
            body.permission_mode.as_deref(),
        ) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    // --- workspace write operations ----------------------------------------

    pub async fn mark_workspace_read(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::mark_workspace_read(&q.id) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn mark_workspace_unread(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::mark_workspace_unread(&q.id) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn pin_workspace(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::pin_workspace(&q.id) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn unpin_workspace(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::unpin_workspace(&q.id) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn set_workspace_manual_status(
        Json(body): Json<SetManualStatusBody>,
    ) -> impl IntoResponse {
        match helmor_lib::dev_api::set_workspace_manual_status(
            &body.workspace_id,
            body.status.as_deref(),
        ) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn archive_workspace(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::archive_workspace(&q.id) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn validate_archive_workspace(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::validate_archive_workspace(&q.id) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn restore_workspace(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::restore_workspace(&q.id) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn validate_restore_workspace(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::validate_restore_workspace(&q.id) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn create_workspace_from_repo(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::create_workspace_from_repo(&q.id) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn permanently_delete_workspace(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::permanently_delete_workspace(&q.id) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn update_intended_target_branch(
        Json(body): Json<UpdateTargetBranchBody>,
    ) -> impl IntoResponse {
        match helmor_lib::dev_api::update_intended_target_branch(
            &body.workspace_id,
            &body.target_branch,
        ) {
            Ok(response) => Json(response).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn prefetch_workspace_remote_refs(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::prefetch_workspace_remote_refs(&q.id) {
            Ok(response) => Json(response).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn update_app_settings(
        Json(body): Json<HashMap<String, String>>,
    ) -> impl IntoResponse {
        match helmor_lib::dev_api::update_app_settings(body) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    // --- streaming agent API -----------------------------------------------

    pub async fn send_agent_message_stream(
        State(state): State<SharedState>,
        Json(body): Json<AgentStreamRequestBody>,
    ) -> impl IntoResponse {
        match helmor_lib::dev_api::start_agent_stream(&state.sidecar, body.request) {
            Ok((response, rx)) => {
                let stream_id = response.stream_id.clone();
                state.streams.lock().await.insert(stream_id, rx);
                Json(response).into_response()
            }
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn agent_stream_sse(
        State(state): State<SharedState>,
        Query(q): Query<StreamIdQuery>,
    ) -> impl IntoResponse {
        let sync_rx = state.streams.lock().await.remove(&q.stream_id);

        match sync_rx {
            Some(sync_rx) => {
                // Bridge sync mpsc → tokio mpsc for SSE
                let (tx, rx) = tokio::sync::mpsc::channel(256);
                tokio::task::spawn_blocking(move || {
                    for event in sync_rx.iter() {
                        if tx.blocking_send(event).is_err() {
                            break;
                        }
                    }
                });

                Sse::new(SseEventStream { rx })
                    .keep_alive(
                        axum::response::sse::KeepAlive::new()
                            .interval(std::time::Duration::from_secs(15)),
                    )
                    .into_response()
            }
            None => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "Stream not found"})),
            )
                .into_response(),
        }
    }

    pub async fn stop_agent_stream(
        State(state): State<SharedState>,
        Json(body): Json<StopAgentStreamBody>,
    ) -> impl IntoResponse {
        match helmor_lib::dev_api::stop_agent_stream(
            &state.sidecar,
            &body.request.session_id,
            body.request.provider.as_deref(),
        ) {
            Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn list_slash_commands(
        State(state): State<SharedState>,
        Query(q): Query<ListSlashCommandsQuery>,
    ) -> impl IntoResponse {
        // The sidecar call is blocking on a sync mpsc, so park it on the
        // blocking pool to keep the axum worker free.
        let sidecar_ptr = Arc::clone(&state);
        let result = tokio::task::spawn_blocking(move || {
            helmor_lib::dev_api::list_slash_commands(
                &sidecar_ptr.sidecar,
                &q.provider,
                q.working_directory.as_deref(),
                q.model_id.as_deref(),
            )
        })
        .await;
        match result {
            Ok(Ok(v)) => Json(v).into_response(),
            Ok(Err(e)) => cmd_err(e).into_response(),
            Err(join_err) => cmd_err(anyhow::anyhow!(
                "listSlashCommands task panicked: {join_err}"
            ))
            .into_response(),
        }
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    // Initialise data directory + schema (same as Tauri setup hook).
    data_dir::ensure_directory_structure().expect("Failed to create Helmor data directory");
    let db_path = data_dir::db_path().expect("Failed to resolve database path");
    let connection = rusqlite::Connection::open(&db_path).expect("Failed to open database");
    helmor_lib::schema_init(&connection);
    drop(connection);

    eprintln!(
        "helmor-dev-server — {} — db: {}",
        data_dir::data_mode_label(),
        db_path.display()
    );

    let state: SharedState = Arc::new(AppState {
        sidecar: ManagedSidecar::new(),
        streams: Mutex::new(HashMap::new()),
    });

    let app = Router::new()
        // --- Read endpoints ---
        .route(
            "/api/list_workspace_groups",
            get(handlers::list_workspace_groups),
        )
        .route("/api/get_workspace", get(handlers::get_workspace))
        .route(
            "/api/list_archived_workspaces",
            get(handlers::list_archived_workspaces),
        )
        .route(
            "/api/list_workspace_sessions",
            get(handlers::list_workspace_sessions),
        )
        .route(
            "/api/list_session_thread_messages",
            get(handlers::list_session_thread_messages),
        )
        .route(
            "/api/list_session_attachments",
            get(handlers::list_session_attachments),
        )
        .route("/api/list_repositories", get(handlers::list_repositories))
        .route(
            "/api/list_agent_model_sections",
            get(handlers::list_agent_model_sections),
        )
        .route("/api/get_data_info", get(handlers::get_data_info))
        .route("/api/get_app_settings", get(handlers::get_app_settings))
        .route(
            "/api/detect_installed_editors",
            get(handlers::detect_installed_editors),
        )
        .route(
            "/api/list_hidden_sessions",
            get(handlers::list_hidden_sessions),
        )
        // Editor file operations
        .route("/api/read_editor_file", get(handlers::read_editor_file))
        .route("/api/write_editor_file", post(handlers::write_editor_file))
        .route("/api/stat_editor_file", get(handlers::stat_editor_file))
        .route("/api/list_editor_files", get(handlers::list_editor_files))
        .route(
            "/api/list_editor_files_with_content",
            get(handlers::list_editor_files_with_content),
        )
        .route(
            "/api/list_workspace_changes",
            get(handlers::list_workspace_changes),
        )
        .route(
            "/api/list_workspace_changes_with_content",
            get(handlers::list_workspace_changes_with_content),
        )
        // --- Session write endpoints ---
        .route("/api/create_session", post(handlers::create_session))
        .route("/api/delete_session", post(handlers::delete_session))
        .route("/api/hide_session", post(handlers::hide_session))
        .route("/api/unhide_session", post(handlers::unhide_session))
        .route("/api/rename_session", post(handlers::rename_session))
        .route("/api/mark_session_read", post(handlers::mark_session_read))
        .route(
            "/api/update_session_settings",
            post(handlers::update_session_settings),
        )
        // --- Workspace write endpoints ---
        .route(
            "/api/mark_workspace_read",
            post(handlers::mark_workspace_read),
        )
        .route(
            "/api/mark_workspace_unread",
            post(handlers::mark_workspace_unread),
        )
        .route("/api/pin_workspace", post(handlers::pin_workspace))
        .route("/api/unpin_workspace", post(handlers::unpin_workspace))
        .route(
            "/api/set_workspace_manual_status",
            post(handlers::set_workspace_manual_status),
        )
        .route("/api/archive_workspace", post(handlers::archive_workspace))
        .route(
            "/api/validate_archive_workspace",
            post(handlers::validate_archive_workspace),
        )
        .route("/api/restore_workspace", post(handlers::restore_workspace))
        .route(
            "/api/validate_restore_workspace",
            post(handlers::validate_restore_workspace),
        )
        .route(
            "/api/create_workspace_from_repo",
            post(handlers::create_workspace_from_repo),
        )
        .route(
            "/api/permanently_delete_workspace",
            post(handlers::permanently_delete_workspace),
        )
        .route(
            "/api/update_intended_target_branch",
            post(handlers::update_intended_target_branch),
        )
        .route(
            "/api/prefetch_workspace_remote_refs",
            post(handlers::prefetch_workspace_remote_refs),
        )
        .route(
            "/api/update_app_settings",
            post(handlers::update_app_settings),
        )
        // --- Streaming agent endpoints ---
        .route(
            "/api/send_agent_message_stream",
            post(handlers::send_agent_message_stream),
        )
        .route("/api/agent_stream_sse", get(handlers::agent_stream_sse))
        .route("/api/stop_agent_stream", post(handlers::stop_agent_stream))
        .route(
            "/api/list_slash_commands",
            get(handlers::list_slash_commands),
        )
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 3001));
    eprintln!("listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
