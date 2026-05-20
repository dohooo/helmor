//! End-to-end integration test for the `helmor-server` F1 slice.
//!
//! Spawns the built binary, writes a JSON-RPC `initialize` request
//! to stdin, reads the response from stdout, asserts on the
//! envelope shape. Catches regressions in the wire framing +
//! handshake gate that pure unit tests can't reach (binary boot,
//! tracing init, stdio flushing).

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use helmor_lib::remote::{JsonRpcId, JsonRpcRequest, JsonRpcResponse, PROTOCOL_VERSION};

fn helmor_server_bin() -> std::path::PathBuf {
    // CARGO_BIN_EXE_<name> is populated by cargo for integration
    // tests so we don't have to guess the target dir layout.
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_helmor-server"))
}

fn spawn_server() -> std::process::Child {
    Command::new(helmor_server_bin())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Set HOSTNAME so the response carries a stable value across
        // hosts the test might run on.
        .env("HOSTNAME", "ci-test.host")
        .spawn()
        .expect("spawn helmor-server")
}

fn write_request(child: &mut std::process::Child, req: &JsonRpcRequest) {
    let stdin = child.stdin.as_mut().expect("stdin captured");
    let line = serde_json::to_string(req).unwrap();
    stdin.write_all(line.as_bytes()).unwrap();
    stdin.write_all(b"\n").unwrap();
    stdin.flush().unwrap();
}

fn read_response(child: &mut std::process::Child) -> JsonRpcResponse {
    let stdout = child.stdout.as_mut().expect("stdout captured");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    serde_json::from_str(line.trim()).expect("response is valid JSON-RPC")
}

#[test]
fn initialize_followed_by_ping_round_trips_through_the_binary() {
    let mut child = spawn_server();

    // Step 1: handshake.
    let init = JsonRpcRequest::new(
        JsonRpcId::Num(1),
        "initialize",
        serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientName": "integration-test",
        }),
    );
    write_request(&mut child, &init);
    let init_resp = read_response(&mut child);
    let result = init_resp.result.expect("initialize returned a result");
    assert_eq!(result["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(result["hostname"], "ci-test.host");

    // Step 2: ping after handshake.
    let ping = JsonRpcRequest::new(
        JsonRpcId::Num(2),
        "ping",
        serde_json::json!({ "counter": 99 }),
    );
    write_request(&mut child, &ping);
    let ping_resp = read_response(&mut child);
    let result = ping_resp.result.expect("ping returned a result");
    assert_eq!(result["counter"], 99);
    assert!(result["serverTime"].is_string());

    // Step 3: runtime.health.
    let health = JsonRpcRequest::new(JsonRpcId::Num(3), "runtime.health", serde_json::json!({}));
    write_request(&mut child, &health);
    let health_resp = read_response(&mut child);
    let result = health_resp
        .result
        .expect("runtime.health returned a result");
    assert_eq!(result["kind"], "local");
    assert_eq!(result["hostname"], "ci-test.host");

    // Close stdin so the binary exits cleanly.
    drop(child.stdin.take());
    let status = child.wait().expect("binary exits");
    assert!(status.success(), "binary exited non-zero: {status:?}");
}

#[test]
fn pre_initialize_calls_get_rejected_with_not_initialized() {
    let mut child = spawn_server();

    let ping = JsonRpcRequest::new(JsonRpcId::Num(1), "ping", serde_json::json!({}));
    write_request(&mut child, &ping);
    let resp = read_response(&mut child);
    let err = resp.error.expect("ping pre-initialize returns an error");
    // Don't pin the exact code — the test should pass even if we
    // adjust the code constant later. Just assert it surfaces as
    // an error envelope referencing the handshake.
    assert!(
        err.message.to_lowercase().contains("initialize"),
        "error message should mention initialize: {}",
        err.message
    );

    drop(child.stdin.take());
    let _ = child.wait();
}

#[test]
fn version_flag_prints_semver_and_protocol_lines_and_exits_zero() {
    let output = Command::new(helmor_server_bin())
        .arg("--version")
        .output()
        .expect("spawn helmor-server --version");
    assert!(output.status.success(), "--version exit non-zero");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();
    let bin_line = lines.next().expect("at least one stdout line");
    let protocol_line = lines.next().expect("a protocol line");
    assert!(
        bin_line.starts_with("helmor-server "),
        "first line should be `helmor-server <semver>`: {bin_line:?}",
    );
    assert!(
        protocol_line.starts_with("protocol "),
        "second line should be `protocol <semver>`: {protocol_line:?}",
    );
    assert!(protocol_line.contains(PROTOCOL_VERSION));
}
