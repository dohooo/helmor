//! JSON-RPC method dispatch for the F1 daemon slice.
//!
//! Three pieces:
//!   - [`ServerContext`] — per-connection state. F1 just carries the
//!     server's version + hostname + the post-`initialize` gate flag.
//!     Later phases (F2-F7) will add the runtime, agent bridge,
//!     terminal registry, etc.
//!   - [`Method`] / [`dispatch_request`] — name → handler routing.
//!   - The handlers themselves — `initialize`, `ping`, `runtime.health`.
//!
//! Handlers stay tiny + pure: `fn(ctx, params) -> Result<R,
//! JsonRpcError>`. The dispatcher owns the version-check gate, the
//! params deserialisation, and the response envelope.

use std::str::FromStr;
use std::sync::Mutex;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::protocol::{
    error_codes, JsonRpcError, JsonRpcId, JsonRpcRequest, JsonRpcResponse, PROTOCOL_VERSION,
};

/// Per-connection state. F1 keeps it deliberately small — later
/// phases will add the runtime, the agent bridge, the terminal
/// registry, etc.
pub struct ServerContext {
    initialized: Mutex<bool>,
    server_version: String,
    hostname: String,
}

impl ServerContext {
    pub fn new(server_version: impl Into<String>, hostname: impl Into<String>) -> Self {
        Self {
            initialized: Mutex::new(false),
            server_version: server_version.into(),
            hostname: hostname.into(),
        }
    }

    /// `true` after a successful `initialize`. Every other method
    /// rejects with [`error_codes::NOT_INITIALIZED`] until then so a
    /// confused client (or a probing port-scanner) can't poke state
    /// without the handshake.
    pub fn is_initialized(&self) -> bool {
        *self
            .initialized
            .lock()
            .expect("server context mutex poisoned")
    }

    /// Server binary version — surfaced in `initialize` responses.
    pub fn server_version(&self) -> &str {
        &self.server_version
    }

    /// Hostname — surfaced in `initialize` + `runtime.health`.
    pub fn hostname(&self) -> &str {
        &self.hostname
    }

    fn mark_initialized(&self) {
        *self
            .initialized
            .lock()
            .expect("server context mutex poisoned") = true;
    }
}

/// Strongly-typed method catalogue. Keeping this as an enum (rather
/// than matching on `&str` inline) lets the dispatcher branch
/// exhaustively + lets `methods.rs` test the round-trip of
/// `as_str` / `from_str`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Initialize,
    Ping,
    RuntimeHealth,
}

impl Method {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Initialize => "initialize",
            Self::Ping => "ping",
            Self::RuntimeHealth => "runtime.health",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownMethod(pub String);

impl std::fmt::Display for UnknownMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unknown remote method: {:?}", self.0)
    }
}

impl std::error::Error for UnknownMethod {}

impl FromStr for Method {
    type Err = UnknownMethod;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "initialize" => Ok(Self::Initialize),
            "ping" => Ok(Self::Ping),
            "runtime.health" => Ok(Self::RuntimeHealth),
            _ => Err(UnknownMethod(value.to_string())),
        }
    }
}

// ── method types ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    /// Wire protocol version the client speaks (see
    /// [`super::protocol::PROTOCOL_VERSION`]). Server rejects with
    /// `IncompatibleProtocol` when the major doesn't match.
    pub protocol_version: String,
    /// Human-readable client name (e.g. `"helmor-desktop"`).
    pub client_name: String,
    /// Client binary version. Optional — older clients omitted it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: String,
    pub server_version: String,
    pub hostname: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingParams {
    /// Opaque counter the client increments so its echo loop can
    /// pair responses with requests without leaning on JSON-RPC
    /// `id`. Defaults to 0 so a sender that doesn't care can pass
    /// `{}`.
    #[serde(default)]
    pub counter: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub counter: u64,
    /// Server-side timestamp (RFC 3339, millisecond precision).
    /// Useful for time-skew debugging across the wire.
    pub server_time: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealthParams {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealthResult {
    /// `"local"` for the daemon binary running on the remote host.
    /// Later phases may expose `"remote"` when a daemon proxies to
    /// another daemon, etc.
    pub kind: String,
    pub hostname: String,
    pub server_version: String,
}

// ── dispatch ──────────────────────────────────────────────────────

/// Decode a JSON-RPC request, dispatch to the matching handler, and
/// build the response envelope. Notifications (`id == null`) get
/// `None` back so the binary's write loop skips the response write.
pub fn dispatch_request(ctx: &ServerContext, req: JsonRpcRequest) -> Option<JsonRpcResponse> {
    let id = req.id.clone();
    let method: Method = match req.method.parse() {
        Ok(m) => m,
        Err(_) => {
            return wrap_error(
                &id,
                error_codes::METHOD_NOT_FOUND,
                format!("unknown method: {}", req.method),
            );
        }
    };

    // Handshake gate.
    if method != Method::Initialize && !ctx.is_initialized() {
        return wrap_error(
            &id,
            error_codes::NOT_INITIALIZED,
            "client must call `initialize` before any other method",
        );
    }

    let outcome: Result<Value, JsonRpcError> = match method {
        Method::Initialize => {
            handle::<InitializeParams, _, _>(req.params, |params| handle_initialize(ctx, params))
        }
        Method::Ping => handle::<PingParams, _, _>(req.params, handle_ping),
        Method::RuntimeHealth => handle::<RuntimeHealthParams, _, _>(req.params, |params| {
            handle_runtime_health(ctx, params)
        }),
    };

    let response = match outcome {
        Ok(result) => JsonRpcResponse::success(id.clone(), result),
        Err(err) => JsonRpcResponse::failure(id.clone(), err),
    };
    if id.is_notification() {
        None
    } else {
        Some(response)
    }
}

fn handle<P, R, F>(raw: Value, handler: F) -> Result<Value, JsonRpcError>
where
    P: DeserializeOwned,
    R: Serialize,
    F: FnOnce(P) -> Result<R, JsonRpcError>,
{
    let params: P = serde_json::from_value(raw)
        .map_err(|err| JsonRpcError::new(error_codes::INVALID_PARAMS, format!("params: {err}")))?;
    let result = handler(params)?;
    serde_json::to_value(result).map_err(|err| {
        JsonRpcError::new(
            error_codes::INTERNAL_ERROR,
            format!("serialise result: {err}"),
        )
    })
}

fn wrap_error(id: &JsonRpcId, code: i32, message: impl Into<String>) -> Option<JsonRpcResponse> {
    if id.is_notification() {
        return None;
    }
    Some(JsonRpcResponse::failure(
        id.clone(),
        JsonRpcError::new(code, message),
    ))
}

// ── handlers ──────────────────────────────────────────────────────

fn handle_initialize(
    ctx: &ServerContext,
    params: InitializeParams,
) -> Result<InitializeResult, JsonRpcError> {
    if !major_versions_match(&params.protocol_version, PROTOCOL_VERSION) {
        return Err(JsonRpcError::new(
            error_codes::INCOMPATIBLE_PROTOCOL,
            format!(
                "incompatible protocol: client speaks {} but server speaks {}",
                params.protocol_version, PROTOCOL_VERSION
            ),
        ));
    }
    ctx.mark_initialized();
    Ok(InitializeResult {
        protocol_version: PROTOCOL_VERSION.to_string(),
        server_version: ctx.server_version().to_string(),
        hostname: ctx.hostname().to_string(),
    })
}

fn handle_ping(params: PingParams) -> Result<PingResult, JsonRpcError> {
    use chrono::SecondsFormat;
    Ok(PingResult {
        counter: params.counter,
        server_time: chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

fn handle_runtime_health(
    ctx: &ServerContext,
    _params: RuntimeHealthParams,
) -> Result<RuntimeHealthResult, JsonRpcError> {
    Ok(RuntimeHealthResult {
        kind: "local".to_string(),
        hostname: ctx.hostname().to_string(),
        server_version: ctx.server_version().to_string(),
    })
}

/// Compare semver majors. `0.x` versions are treated as
/// "majors == major + minor" so two `0.1.*` peers see each other as
/// compatible but a `0.1.*` peer rejects a `0.2.*` peer. Once we
/// reach `1.0` the standard "majors match" semantics kick in.
fn major_versions_match(a: &str, b: &str) -> bool {
    fn major_minor(v: &str) -> Option<(u32, u32)> {
        let mut parts = v.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok().unwrap_or(0);
        Some((major, minor))
    }
    match (major_minor(a), major_minor(b)) {
        (Some((maj_a, min_a)), Some((maj_b, min_b))) => {
            if maj_a == 0 || maj_b == 0 {
                maj_a == maj_b && min_a == min_b
            } else {
                maj_a == maj_b
            }
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ServerContext {
        ServerContext::new("0.0.0-test", "test.host")
    }

    fn initialize(ctx: &ServerContext) {
        let req = JsonRpcRequest::new(
            JsonRpcId::Num(1),
            "initialize",
            serde_json::json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientName": "test-client",
            }),
        );
        let resp = dispatch_request(ctx, req).expect("initialize must respond");
        assert!(resp.error.is_none(), "initialize failed: {resp:?}");
        assert!(ctx.is_initialized());
    }

    #[test]
    fn method_roundtrips_through_str() {
        for m in [Method::Initialize, Method::Ping, Method::RuntimeHealth] {
            assert_eq!(m.as_str().parse::<Method>().unwrap(), m);
        }
    }

    #[test]
    fn unknown_method_returns_method_not_found() {
        let req = JsonRpcRequest::new(JsonRpcId::Num(1), "foo.bar", serde_json::json!({}));
        let resp = dispatch_request(&ctx(), req).expect("response expected");
        let err = resp.error.expect("error expected");
        assert_eq!(err.code, error_codes::METHOD_NOT_FOUND);
    }

    #[test]
    fn pre_initialize_calls_are_rejected() {
        let req = JsonRpcRequest::new(JsonRpcId::Num(1), "ping", serde_json::json!({}));
        let resp = dispatch_request(&ctx(), req).expect("response expected");
        let err = resp.error.expect("error expected");
        assert_eq!(err.code, error_codes::NOT_INITIALIZED);
    }

    #[test]
    fn initialize_accepts_matching_major() {
        let ctx = ctx();
        initialize(&ctx);
    }

    #[test]
    fn initialize_rejects_incompatible_major() {
        let ctx = ctx();
        let req = JsonRpcRequest::new(
            JsonRpcId::Num(1),
            "initialize",
            serde_json::json!({
                "protocolVersion": "9.0.0",
                "clientName": "test-client",
            }),
        );
        let resp = dispatch_request(&ctx, req).expect("response expected");
        let err = resp.error.expect("error expected");
        assert_eq!(err.code, error_codes::INCOMPATIBLE_PROTOCOL);
        assert!(!ctx.is_initialized());
    }

    #[test]
    fn ping_echoes_counter_after_initialize() {
        let ctx = ctx();
        initialize(&ctx);
        let req = JsonRpcRequest::new(
            JsonRpcId::Num(2),
            "ping",
            serde_json::json!({ "counter": 42 }),
        );
        let resp = dispatch_request(&ctx, req).expect("response expected");
        let result = resp.result.expect("result expected");
        assert_eq!(result["counter"], 42);
        assert!(result["serverTime"].is_string());
    }

    #[test]
    fn runtime_health_returns_kind_local_and_hostname() {
        let ctx = ctx();
        initialize(&ctx);
        let req = JsonRpcRequest::new(JsonRpcId::Num(3), "runtime.health", serde_json::json!({}));
        let resp = dispatch_request(&ctx, req).expect("response expected");
        let result = resp.result.expect("result expected");
        assert_eq!(result["kind"], "local");
        assert_eq!(result["hostname"], "test.host");
        assert_eq!(result["serverVersion"], "0.0.0-test");
    }

    #[test]
    fn notification_id_null_suppresses_response() {
        let ctx = ctx();
        initialize(&ctx);
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: JsonRpcId::Null,
            method: "ping".into(),
            params: serde_json::json!({}),
        };
        assert!(dispatch_request(&ctx, req).is_none());
    }

    #[test]
    fn invalid_params_returns_invalid_params() {
        let ctx = ctx();
        initialize(&ctx);
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: JsonRpcId::Num(4),
            method: "ping".into(),
            // counter must be a u64 — passing a string forces a
            // params decode failure.
            params: serde_json::json!({ "counter": "not a number" }),
        };
        let resp = dispatch_request(&ctx, req).expect("response expected");
        let err = resp.error.expect("error expected");
        assert_eq!(err.code, error_codes::INVALID_PARAMS);
    }

    #[test]
    fn major_zero_matches_on_minor_too() {
        // Two `0.1.x` peers should accept each other.
        assert!(major_versions_match("0.1.0", "0.1.5"));
        // A `0.1.x` peer rejects a `0.2.x` peer (we treat 0.x as
        // pre-stable; minor bumps are breaking).
        assert!(!major_versions_match("0.1.0", "0.2.0"));
    }

    #[test]
    fn post_one_zero_matches_majors_only() {
        assert!(major_versions_match("1.5.0", "1.0.0"));
        assert!(!major_versions_match("1.0.0", "2.0.0"));
    }
}
