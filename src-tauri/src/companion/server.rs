//! axum router + handlers for the companion HTTP surface.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header::CONTENT_TYPE, HeaderMap, StatusCode, Uri},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures::{stream, Stream, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tower_http::cors::{Any, CorsLayer};

use super::{auth, Verifier};
use crate::error::CommandError;

/// Resolves a request path to embedded SPA bytes + MIME type. Type-erased so
/// the HTTP layer stays runtime-agnostic (the Tauri `AssetResolver` is captured
/// behind this closure in [`super::CompanionState::start`]); this also lets the
/// integration test run without a real asset bundle.
pub type AssetLoader = Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;

/// Starts a streaming command (`send_agent_message_stream` or
/// `subscribe_ui_mutations`): given the command name + args, feeds each event as
/// an NDJSON line into the sender. Type-erased so the server stays
/// runtime-agnostic; built from a concrete `AppHandle` in [`super::stream`].
pub type StreamStarter =
    Arc<dyn Fn(&str, Value, UnboundedSender<String>) -> Result<(), CommandError> + Send + Sync>;

/// Dispatches a non-streaming `/rpc/{cmd}` call to the real Tauri command behind
/// the concrete `AppHandle` (so commands needing `State`/`AppHandle` work).
/// Type-erased so the server stays runtime-agnostic; built in
/// [`super::rpc::build_dispatcher`]. Takes owned `(cmd, args)` so the returned
/// future is `'static`.
pub type Dispatcher = Arc<
    dyn Fn(String, Value) -> futures::future::BoxFuture<'static, Result<Value, CommandError>>
        + Send
        + Sync,
>;

/// Shared state injected into every handler.
#[derive(Clone)]
pub struct AppState {
    /// In-memory dev bearer token (Slice 0).
    pub token: Arc<String>,
    /// Loads embedded SPA assets (same bundle the desktop webview serves).
    pub assets: AssetLoader,
    /// Starts a streaming command (reuses the desktop streaming paths).
    pub streamer: StreamStarter,
    /// Dispatches non-streaming `/rpc/{cmd}` calls to the real commands.
    pub dispatcher: Dispatcher,
    /// Verifies bearer tokens beyond the dev token (paired-device PATs).
    pub verifier: Verifier,
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
        .route("/rpc-stream/{cmd}", post(rpc_stream_handler))
        .route("/v1/stream", get(stream_handler))
        .route("/v1/asset", get(asset_handler))
        // Everything else: serve the embedded SPA (unauthenticated — the bundle
        // is public; data behind /rpc still requires the bearer token).
        .fallback(serve_asset)
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
    if !auth::authorize(&headers, state.token.as_str(), &state.verifier) {
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

    match (state.dispatcher)(cmd, args).await {
        Ok(value) => Json(value).into_response(),
        Err(command_error) => {
            // `CommandError` serialises as { code, message } — the same shape
            // native IPC errors arrive in, so the browser transport surfaces
            // them identically.
            let payload = serde_json::to_value(&command_error)
                .unwrap_or_else(|_| json!({ "code": "Unknown", "message": "Internal error" }));
            (StatusCode::BAD_REQUEST, Json(payload)).into_response()
        }
    }
}

/// `POST /rpc-stream/{cmd}` — bearer-gated streaming dispatch. The response is
/// newline-delimited JSON (one serialized event per line), which the browser
/// shim (`src/lib/ipc.ts`) pumps into the `Channel.onmessage` handler.
async fn rpc_stream_handler(
    State(state): State<AppState>,
    Path(cmd): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !auth::authorize(&headers, state.token.as_str(), &state.verifier) {
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

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    match (state.streamer)(&cmd, args, tx) {
        Ok(()) => {
            let stream = UnboundedReceiverStream::new(rx).map(|line| {
                Ok::<Bytes, std::convert::Infallible>(Bytes::from(format!("{line}\n")))
            });
            (
                [(CONTENT_TYPE, "application/x-ndjson")],
                axum::body::Body::from_stream(stream),
            )
                .into_response()
        }
        Err(command_error) => {
            let payload = serde_json::to_value(&command_error)
                .unwrap_or_else(|_| json!({ "code": "Unknown", "message": "Internal error" }));
            (StatusCode::BAD_REQUEST, Json(payload)).into_response()
        }
    }
}

/// Serve a static asset from the app's embedded frontend bundle (the same
/// assets the desktop webview loads; in dev the resolver falls back to the
/// `frontendDist` directory). Unknown client-side routes fall back to
/// `index.html` so the SPA router can take over.
async fn serve_asset(State(state): State<AppState>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let candidate = if path.is_empty() { "index.html" } else { path };
    if let Some(response) = load_asset(&state, candidate) {
        return response;
    }
    if let Some(response) = load_asset(&state, "index.html") {
        return response;
    }
    (StatusCode::NOT_FOUND, "asset not found").into_response()
}

fn load_asset(state: &AppState, path: &str) -> Option<Response> {
    let (raw, mime) = (state.assets)(path)?;
    let bytes = if path == "index.html" {
        inject_companion_marker(raw)
    } else {
        raw
    };
    Some(([(CONTENT_TYPE, mime)], bytes).into_response())
}

/// Inject the companion marker into `index.html` so `src/lib/ipc.ts` switches
/// the transport onto HTTP/SSE. The bearer token is delivered separately (URL
/// hash → localStorage), so the marker itself carries no secret.
fn inject_companion_marker(html: Vec<u8>) -> Vec<u8> {
    const MARKER: &str = "<script>window.__HELMOR_COMPANION__={};</script>";
    let Ok(text) = String::from_utf8(html) else {
        return Vec::new();
    };
    let injected = match text.find("</head>") {
        Some(idx) => format!("{}{MARKER}{}", &text[..idx], &text[idx..]),
        None => format!("{MARKER}{text}"),
    };
    injected.into_bytes()
}

/// `GET /v1/stream` — bearer-gated SSE. Slice 0 emits a `hello` event then
/// periodic `ping`s; the pipeline → SSE wiring replaces the body later. The
/// named-event shape is already what `src/lib/ipc.ts` consumes.
async fn stream_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !auth::authorize(&headers, state.token.as_str(), &state.verifier) {
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

// ---------------------------------------------------------------------------
// `<img>` asset serving (companion `convertFileSrc`)
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct AssetQuery {
    path: String,
}

/// `GET /v1/asset?path=<local file>` — serves an on-disk image so the phone can
/// render avatars / pasted / generated images (`convertFileSrc` targets in
/// companion mode). Auth is via the `helmor_companion_pat` cookie because an
/// `<img>` element can't send an `Authorization` header.
///
/// HARD-restricted to the avatar / generated-image / paste-cache directories so
/// a paired device can never pull `helmor.db`, logs, or arbitrary workspace
/// files. Paths are canonicalised first, so `..` / symlink escapes are rejected.
async fn asset_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AssetQuery>,
) -> Response {
    let Some(token) = cookie_token(&headers) else {
        return unauthorized();
    };
    if !auth::authorize_token(&token, state.token.as_str(), &state.verifier) {
        return unauthorized();
    }
    let Some(file) = resolve_allowed_image_file(&query.path) else {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    };
    match tokio::fs::read(&file).await {
        Ok(bytes) => ([(CONTENT_TYPE, image_mime(&file))], bytes).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// Extract the `helmor_companion_pat` value from the `Cookie` header.
fn cookie_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|pair| pair.trim().strip_prefix("helmor_companion_pat="))
        .map(str::to_string)
        .next()
}

/// Directories a paired device may read images from. Everything else (the
/// SQLite DB, logs, query cache, workspace files) is off-limits.
fn allowed_image_dirs() -> Vec<std::path::PathBuf> {
    [
        crate::data_dir::avatar_cache_dir(),
        crate::data_dir::generated_images_dir(),
        crate::data_dir::paste_cache_dir(),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// Canonicalise `requested` (resolving `..` / symlinks; requires it to exist)
/// and accept it only if it lives inside one of the allowed image dirs.
fn resolve_allowed_image_file(requested: &str) -> Option<std::path::PathBuf> {
    let candidate = std::fs::canonicalize(requested).ok()?;
    let dirs: Vec<std::path::PathBuf> = allowed_image_dirs()
        .iter()
        .filter_map(|dir| std::fs::canonicalize(dir).ok())
        .collect();
    path_is_within(&candidate, &dirs).then_some(candidate)
}

fn path_is_within(candidate: &std::path::Path, dirs: &[std::path::PathBuf]) -> bool {
    dirs.iter().any(|dir| candidate.starts_with(dir))
}

fn image_mime(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use axum::http::{header::COOKIE, HeaderMap, HeaderValue};

    use super::{cookie_token, path_is_within, resolve_allowed_image_file};

    #[test]
    fn cookie_token_extracts_pat() {
        let mut headers = HeaderMap::new();
        headers.insert(
            COOKIE,
            HeaderValue::from_static("foo=1; helmor_companion_pat=hlm_abc; bar=2"),
        );
        assert_eq!(cookie_token(&headers).as_deref(), Some("hlm_abc"));
        assert_eq!(cookie_token(&HeaderMap::new()), None);
    }

    #[test]
    fn path_is_within_prefix_logic() {
        let dirs = vec![PathBuf::from("/data/cache/avatars")];
        assert!(path_is_within(
            Path::new("/data/cache/avatars/x.png"),
            &dirs
        ));
        assert!(!path_is_within(Path::new("/data/helmor.db"), &dirs));
        assert!(!path_is_within(Path::new("/etc/passwd"), &dirs));
    }

    #[test]
    fn allows_avatar_rejects_db_and_traversal() {
        let _env = crate::testkit::TestEnv::new("companion-asset");
        let avatars = crate::data_dir::avatar_cache_dir().unwrap();
        std::fs::create_dir_all(&avatars).unwrap();
        let img = avatars.join("a.png");
        std::fs::write(&img, b"x").unwrap();

        // Allowed: a real file under the avatar cache dir.
        assert!(resolve_allowed_image_file(img.to_str().unwrap()).is_some());

        // Rejected: the SQLite DB under the data dir.
        let db = crate::data_dir::data_dir().unwrap().join("helmor.db");
        std::fs::write(&db, b"db").unwrap();
        assert!(resolve_allowed_image_file(db.to_str().unwrap()).is_none());

        // Rejected: a `..` escape out of the avatar dir back to the DB.
        let traversal = format!("{}/../../helmor.db", avatars.display());
        assert!(resolve_allowed_image_file(&traversal).is_none());
    }
}
