//! Debug: replay a stream fixture and dump every Full emission's part list.
//! Usage: cargo run --example debug_stream_replay -- <fixture.jsonl> [--all]

use helmor_lib::pipeline::{MessagePipeline, PipelineEmit};
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
            "tool:{}(id={} args_keys={:?} hasResult={} status={:?})",
            p.get("toolName").and_then(Value::as_str).unwrap_or("?"),
            p.get("toolCallId").and_then(Value::as_str).unwrap_or("-"),
            p.get("args")
                .and_then(Value::as_object)
                .map(|o| o.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default(),
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

fn dump(label: &str, msgs: &[helmor_lib::pipeline::types::ThreadMessageLike]) {
    println!("== {label}");
    for m in msgs {
        let v = serde_json::to_value(m).unwrap();
        let role = v.get("role").and_then(Value::as_str).unwrap_or("?");
        let id = v.get("id").and_then(Value::as_str).unwrap_or("-");
        let streaming = v.get("streaming").and_then(Value::as_bool);
        println!("  [{role}] id={id} streaming={streaming:?}");
        if let Some(parts) = v.get("content").and_then(Value::as_array) {
            for p in parts {
                println!("    {}", part_brief(p));
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = &args[1];
    let show_all = args.iter().any(|a| a == "--all");
    let data = std::fs::read_to_string(path).unwrap();
    let mut pipeline = MessagePipeline::new("claude", "model", "ctx", "sess");
    for (i, line) in data.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line).unwrap();
        let etype = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();
        match pipeline.push_event(&value, line) {
            PipelineEmit::Full(msgs) => {
                if show_all {
                    dump(&format!("line {i} ({etype}) FULL"), &msgs);
                }
            }
            PipelineEmit::Partial(msg) => {
                if show_all {
                    dump(&format!("line {i} ({etype}) PARTIAL"), &[msg]);
                }
            }
            PipelineEmit::None => {}
        }
    }
    let final_msgs = pipeline.finish();
    dump("FINISH", &final_msgs);
}
