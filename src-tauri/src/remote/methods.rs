//! RPC method catalogue.
//!
//! Each method is a typed `(params, result)` pair so the server and
//! client agree on shape at compile time, not at JSON-parse time.
//! Adding a new method is:
//!
//! 1. Define its `Params` + `Result` structs in this file.
//! 2. Add a [`Method`] enum variant that names it.
//! 3. Register a handler in [`super::server::dispatch_request`].
//!
//! The cap on methods this slice adds is intentionally small —
//! `initialize` (handshake) and `ping` (liveness probe). The richer
//! workspace / script / sidecar method set is layered on by later
//! phases of the remote-runner work.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// All methods the protocol recognises. Used by the client side to
/// type-check requests and by the server side to dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// Mandatory handshake. Carries the client's protocol version;
    /// the server rejects with `IncompatibleProtocol` if the major
    /// version doesn't match.
    Initialize,
    /// Cheap liveness probe. Client → server, server echoes a
    /// counter so latency / liveness can be measured without
    /// touching the workspace state.
    Ping,
    /// Read-only `git status` projection for a workspace. First
    /// real method on the trait seam — proves the local impl
    /// and the dispatch layer work end-to-end before the SSH
    /// transport lands.
    WorkspaceStatus,
}

impl Method {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Initialize => "initialize",
            Self::Ping => "ping",
            Self::WorkspaceStatus => "workspace.status",
        }
    }
}

/// Surfaced when [`Method::from_str`] receives a method name the
/// protocol doesn't recognise. Carried out of the dispatcher as
/// JSON-RPC `METHOD_NOT_FOUND`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownMethod(pub String);

impl fmt::Display for UnknownMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
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
            "workspace.status" => Ok(Self::WorkspaceStatus),
            _ => Err(UnknownMethod(value.to_string())),
        }
    }
}

/// Helper trait so both sides can talk about a method by its strongly
/// typed param/result shapes. Server code uses it to deserialise
/// params; client code uses it to build a typed request.
pub trait RpcMethod {
    const NAME: &'static str;
    type Params: Serialize + for<'de> Deserialize<'de>;
    type Result: Serialize + for<'de> Deserialize<'de>;
}

// ── initialize ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    /// Protocol version the client speaks (matches
    /// [`super::protocol::PROTOCOL_VERSION`] for compatible peers).
    pub protocol_version: String,
    /// Human-readable client name. Logged on the server side so a
    /// remote operator can tell who connected.
    pub client_name: String,
    /// Optional client build version. Surfaced in `tracing` logs and
    /// in future diagnostics commands. `None` for ad-hoc clients
    /// (CLI probes, tests).
    #[serde(default)]
    pub client_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    /// Protocol version the server speaks. Client must verify the
    /// majors match before continuing.
    pub protocol_version: String,
    /// Server binary's package version (e.g. `0.22.1`). Used for
    /// future deprecation messaging.
    pub server_version: String,
    /// Free-form server hostname / label for the UI. Today this is
    /// `hostname` on Unix; later phases may surface a user-set name.
    pub hostname: String,
}

pub struct InitializeMethod;
impl RpcMethod for InitializeMethod {
    const NAME: &'static str = "initialize";
    type Params = InitializeParams;
    type Result = InitializeResult;
}

// ── ping ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingParams {
    /// Opaque counter the client increments so its echo loop can
    /// pair responses with requests without leaning on JSON-RPC
    /// `id`. Useful when the client side multiplexes ping with
    /// other traffic on the same pipe.
    #[serde(default)]
    pub counter: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    /// Echo of the counter the client sent.
    pub counter: u64,
    /// Server-side timestamp (RFC 3339, millisecond precision).
    /// Surfaced in the connection-health panel and useful for
    /// debugging time-skew issues over SSH.
    pub server_time: String,
}

pub struct PingMethod;
impl RpcMethod for PingMethod {
    const NAME: &'static str = "ping";
    type Params = PingParams;
    type Result = PingResult;
}

// ── workspace.status ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatusParams {
    /// Absolute filesystem path to the workspace directory. For the
    /// SSH transport, this is interpreted on the *server's* filesystem
    /// — clients can't pass local paths verbatim and expect them to
    /// resolve. A later phase will likely replace this with a logical
    /// workspace identifier resolved server-side.
    pub workspace_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatusResult {
    /// True iff `git status --porcelain --untracked-files=normal`
    /// produced no output. Equivalent to "nothing staged, unstaged,
    /// or untracked".
    pub is_clean: bool,
    /// Paths from porcelain output, sorted + deduped. Status code
    /// prefixes are stripped — the UI just needs the set of changed
    /// files for a count or list.
    pub changed_paths: Vec<String>,
}

pub struct WorkspaceStatusMethod;
impl RpcMethod for WorkspaceStatusMethod {
    const NAME: &'static str = "workspace.status";
    type Params = WorkspaceStatusParams;
    type Result = WorkspaceStatusResult;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn method_enum_round_trips_through_strings() {
        for method in [Method::Initialize, Method::Ping, Method::WorkspaceStatus] {
            assert_eq!(method.as_str().parse::<Method>().ok(), Some(method));
        }
        assert!("not-a-method".parse::<Method>().is_err());
    }

    #[test]
    fn workspace_status_wire_shapes_are_camel_case() {
        let params = WorkspaceStatusParams {
            workspace_dir: "/tmp/example".into(),
        };
        let wire = serde_json::to_string(&params).unwrap();
        assert!(wire.contains("\"workspaceDir\""));

        let result = WorkspaceStatusResult {
            is_clean: false,
            changed_paths: vec!["src/foo.rs".into()],
        };
        let wire = serde_json::to_string(&result).unwrap();
        assert!(wire.contains("\"isClean\""));
        assert!(wire.contains("\"changedPaths\""));
        assert!(!wire.contains('_'), "snake_case leaked: {wire}");
    }

    #[test]
    fn initialize_params_are_camel_case_on_the_wire() {
        let params = InitializeParams {
            protocol_version: "0.1.0".into(),
            client_name: "helmor".into(),
            client_version: Some("0.22.1".into()),
        };
        let wire = serde_json::to_string(&params).unwrap();
        assert!(wire.contains("\"protocolVersion\""));
        assert!(wire.contains("\"clientName\""));
        assert!(wire.contains("\"clientVersion\""));
        assert!(!wire.contains('_'), "snake_case leaked: {wire}");
    }

    #[test]
    fn ping_counter_defaults_to_zero_when_absent() {
        // The client side often probes without setting a counter
        // (e.g. the first liveness check); the server should accept
        // that.
        let params: PingParams = serde_json::from_str("{}").unwrap();
        assert_eq!(params.counter, 0);
    }
}
