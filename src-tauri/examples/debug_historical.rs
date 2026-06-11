//! Debug: run convert_historical on a pipeline fixture and dump part lists.
//! Usage: cargo run --example debug_historical -- <fixture-dir-or-input.json>

use helmor_lib::pipeline::types::HistoricalRecord;
use helmor_lib::pipeline::MessagePipeline;
use serde_json::Value;

fn part_brief(p: &Value) -> String {
    let t = p.get("type").and_then(Value::as_str).unwrap_or("?");
    match t {
        "reasoning" => format!(
            "reasoning(id={} len={} dur={:?})",
            p.get("id").and_then(Value::as_str).unwrap_or("-"),
            p.get("text")
                .and_then(Value::as_str)
                .map(str::len)
                .unwrap_or(0),
            p.get("durationMs").and_then(Value::as_u64),
        ),
        "tool-call" => format!(
            "tool:{}(id={} hasResult={} status={:?})",
            p.get("toolName").and_then(Value::as_str).unwrap_or("?"),
            p.get("toolCallId").and_then(Value::as_str).unwrap_or("-"),
            p.get("result").is_some(),
            p.get("status").and_then(Value::as_str),
        ),
        "text" => format!(
            "text(len={})",
            p.get("text")
                .and_then(Value::as_str)
                .map(str::len)
                .unwrap_or(0)
        ),
        "collapsed-group" => format!(
            "collapsed-group(n={})",
            p.get("tools")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
        ),
        other => other.to_string(),
    }
}

fn main() {
    let arg = std::env::args().nth(1).unwrap();
    let path = if arg.ends_with(".json") {
        arg.clone()
    } else {
        format!("{arg}/input.json")
    };
    let data = std::fs::read_to_string(&path).unwrap();
    let raw: Vec<Value> = serde_json::from_str(&data).unwrap();
    let records: Vec<HistoricalRecord> = raw
        .iter()
        .map(|r| HistoricalRecord {
            id: r
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            role: serde_json::from_value(r.get("role").cloned().unwrap()).unwrap(),
            content: r
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            parsed_content: r.get("parsed_content").cloned(),
            created_at: r
                .get("created_at")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        })
        .collect();
    let msgs = MessagePipeline::convert_historical(&records);
    println!("messages: {}", msgs.len());
    for m in &msgs {
        let v = serde_json::to_value(m).unwrap();
        let role = v.get("role").and_then(Value::as_str).unwrap_or("?");
        println!("== [{role}] streaming={:?}", v.get("streaming"));
        if let Some(parts) = v.get("content").and_then(Value::as_array) {
            for p in parts {
                println!("  {}", part_brief(p));
            }
        }
    }
}
