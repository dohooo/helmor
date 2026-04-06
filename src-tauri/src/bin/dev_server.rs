//! Lightweight HTTP server that mirrors Tauri IPC commands for browser-based
//! frontend development.  Run with:
//!
//!   cargo run --bin helmor-dev-server --features dev-server
//!
//! Then start the Vite dev server (`pnpm run dev`) and open Chrome at
//! localhost:1420.  The frontend will detect the absence of the Tauri runtime
//! and call `/api/*` endpoints instead.

use std::net::SocketAddr;

use axum::{extract::Query, http::StatusCode, response::IntoResponse, routing::get, Json, Router};
use tower_http::cors::CorsLayer;

use helmor_lib::data_dir;

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

// ---------------------------------------------------------------------------
// Route handlers — thin wrappers around the library functions
// ---------------------------------------------------------------------------

mod handlers {
    use super::*;

    // We cannot directly import private modules from helmor_lib, but the
    // public Tauri command functions are re-exported via `models` and `agents`.
    // Since models/agents are not pub in lib.rs, we replicate the thin wrapper
    // pattern here, calling the same underlying code.

    // The library exposes `data_dir`, `error`, and `sidecar` as pub.
    // For models we need to reach into the crate internals.  The easiest path
    // is to make the necessary modules pub in lib.rs.  However, to keep changes
    // minimal we duplicate the thin wrapper logic here — each handler opens a
    // DB connection and runs the same SQL the Tauri command would.

    // --- workspace groups ---------------------------------------------------

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

    // --- sessions / messages ------------------------------------------------

    pub async fn list_workspace_sessions(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::list_workspace_sessions(&q.id) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
        }
    }

    pub async fn list_session_messages(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::list_session_messages(&q.id) {
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

    // --- repos / models / misc ----------------------------------------------

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

    pub async fn list_hidden_sessions(Query(q): Query<IdQuery>) -> impl IntoResponse {
        match helmor_lib::dev_api::list_hidden_sessions(&q.id) {
            Ok(v) => Json(v).into_response(),
            Err(e) => cmd_err(e).into_response(),
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

    let app = Router::new()
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
            "/api/list_session_messages",
            get(handlers::list_session_messages),
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
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([127, 0, 0, 1], 3001));
    eprintln!("listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
