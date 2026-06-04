//! axum router + handlers for the companion HTTP surface.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures::{stream, Stream, StreamExt};
use serde_json::{json, Value};
use tower_http::cors::{Any, CorsLayer};

use super::{auth, rpc};

/// Shared state injected into every handler.
#[derive(Clone)]
pub struct AppState {
    /// In-memory dev bearer token (Slice 0).
    pub token: Arc<String>,
}

/// Build the router. CORS is wide-open because every route is bearer-gated and
/// the frontend is served same-origin in production; the permissive policy
/// only matters for local cross-port dev.
pub fn router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/v1/health", get(health))
        .route("/rpc/{cmd}", post(rpc_handler))
        .route("/v1/stream", get(stream_handler))
        .layer(cors)
        .with_state(state)
}

/// Unauthenticated liveness probe.
async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "helmor-companion",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// `POST /rpc/{cmd}` — bearer-gated command dispatch. Body is the JSON args
/// object (or empty for no-arg commands).
async fn rpc_handler(
    State(state): State<AppState>,
    Path(cmd): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !auth::check_bearer(&headers, state.token.as_str()) {
        return unauthorized();
    }

    let args: Value = if body.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "code": "Unknown",
                        "message": format!("Invalid JSON body: {error}"),
                    })),
                )
                    .into_response();
            }
        }
    };

    match rpc::dispatch(&cmd, args).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => {
            // Reuse the Tauri command error shape ({ code, message }) so the
            // browser transport surfaces errors identically to native IPC.
            let command_error = crate::error::CommandError::from(error);
            let payload = serde_json::to_value(&command_error)
                .unwrap_or_else(|_| json!({ "code": "Unknown", "message": "Internal error" }));
            (StatusCode::BAD_REQUEST, Json(payload)).into_response()
        }
    }
}

/// `GET /v1/stream` — bearer-gated SSE. Slice 0 emits a `hello` event then
/// periodic `ping`s; the pipeline → SSE wiring replaces the body later. The
/// named-event shape is already what `src/lib/ipc.ts` consumes.
async fn stream_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !auth::check_bearer(&headers, state.token.as_str()) {
        return unauthorized();
    }
    Sse::new(keepalive_stream())
        .keep_alive(KeepAlive::default())
        .into_response()
}

fn keepalive_stream() -> impl Stream<Item = Result<Event, std::convert::Infallible>> {
    let hello = stream::once(async {
        Ok::<_, std::convert::Infallible>(Event::default().event("hello").data("{}"))
    });
    let interval = tokio::time::interval(Duration::from_secs(15));
    let pings = tokio_stream::wrappers::IntervalStream::new(interval)
        .map(|_| Ok::<_, std::convert::Infallible>(Event::default().event("ping").data("{}")));
    hello.chain(pings)
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "code": "Unauthorized",
            "message": "Missing or invalid bearer token",
        })),
    )
        .into_response()
}
