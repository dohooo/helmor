//! Minimal MCP (Model Context Protocol) server over stdio.
//!
//! Implements JSON-RPC 2.0 with tools capability. Each request is one
//! line of JSON on stdin; each response is one line on stdout.
//!
//! ## Tool catalog (Phase B)
//!
//! This MCP surface exposes Helmor's domain operations that don't
//! require Tauri runtime state (no `AppHandle`, no `ScriptProcessManager`,
//! no `ActiveStreams`).
//!
//! The MCP variants of `*_list` / `*_show` tools drop the "is this
//! session live-streaming?" enrichment fields (`isWorking`,
//! `activeSessionStatus`) because there's no in-process `ActiveStreams`
//! to consult. Callers see stored status only.

use anyhow::Result;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

mod catalog;
mod response;
mod tools;
use catalog::tool_catalog;
pub fn run_mcp_server() -> Result<()> {
    // Bootstrap DB (same as CLI)
    crate::data_dir::ensure_directory_structure()?;
    let db_path = crate::data_dir::db_path()?;
    let conn = rusqlite::Connection::open(&db_path)?;
    crate::schema_init(&conn);
    drop(conn);

    let stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();

    for line in stdin.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let resp = json_rpc_error(Value::Null, -32700, &format!("Parse error: {e}"));
                writeln!(stdout, "{}", serde_json::to_string(&resp)?)?;
                stdout.flush()?;
                continue;
            }
        };

        let method = request.get("method").and_then(Value::as_str).unwrap_or("");

        // Notifications have no id — don't send a response
        if method.starts_with("notifications/") {
            continue;
        }

        let response = match method {
            "initialize" => handle_initialize(&request),
            "ping" => handle_ping(&request),
            "tools/list" => handle_tools_list(&request),
            "tools/call" => handle_tools_call(&request),
            _ => json_rpc_error(
                request["id"].clone(),
                -32601,
                &format!("Method not found: {method}"),
            ),
        };

        writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
        stdout.flush()?;
    }

    Ok(())
}

fn handle_initialize(request: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": request["id"],
        "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": "helmor",
                "version": "0.1.0"
            }
        }
    })
}

fn handle_ping(request: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": request["id"], "result": {} })
}

fn handle_tools_list(request: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": request["id"],
        "result": { "tools": tool_catalog() }
    })
}

fn handle_tools_call(request: &Value) -> Value {
    let id = request["id"].clone();
    let tool_name = request["params"]["name"].as_str().unwrap_or("");
    let args = &request["params"]["arguments"];

    let result = tools::dispatch_tool(tool_name, args);

    match result {
        Ok(text) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{ "type": "text", "text": text }],
                "isError": false
            }
        }),
        Err(e) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{ "type": "text", "text": format!("Error: {e:#}") }],
                "isError": true
            }
        }),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn json_rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}
