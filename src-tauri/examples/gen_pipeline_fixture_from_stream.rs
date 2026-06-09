use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use helmor_lib::pipeline::types::HistoricalRecord;
use helmor_lib::pipeline::MessagePipeline;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
struct HistoricalRecordFixture {
    id: String,
    role: String,
    content: String,
    parsed_content: Option<Value>,
    created_at: String,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!(
            "Usage: gen_pipeline_fixture_from_stream <provider> <stream_jsonl> <fixture_name>"
        );
        return ExitCode::from(2);
    }

    match run(&args[1], &args[2], &args[3]) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(provider: &str, stream_jsonl: &str, fixture_name: &str) -> Result<()> {
    let raw = fs::read_to_string(stream_jsonl)
        .with_context(|| format!("read stream fixture {stream_jsonl}"))?;
    let mut pipeline = MessagePipeline::new(provider, "gpt-5.4", "fixture", "fixture-session");

    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        let value: Value =
            serde_json::from_str(line).with_context(|| format!("parse stream line: {line}"))?;
        let _ = pipeline.push_event(&value, line);
    }
    let _ = pipeline.finish();

    let acc = &pipeline.accumulator;
    let records: Vec<HistoricalRecord> = (0..acc.turns_len())
        .map(|index| {
            let turn = acc.turn_at(index);
            HistoricalRecord {
                id: turn.id.clone(),
                role: turn.role,
                content: turn.content_json.clone(),
                parsed_content: serde_json::from_str(&turn.content_json).ok(),
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
            }
        })
        .collect();

    if records.is_empty() {
        anyhow::bail!("No persisted turns were produced from {stream_jsonl}");
    }

    let fixtures_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("pipeline")
        .join(fixture_name);
    fs::create_dir_all(&fixtures_dir)
        .with_context(|| format!("create fixture dir {fixtures_dir:?}"))?;

    let input_fixtures: Vec<HistoricalRecordFixture> = records
        .iter()
        .map(|record| HistoricalRecordFixture {
            id: record.id.clone(),
            role: record.role.as_str().to_string(),
            content: record.content.clone(),
            parsed_content: record.parsed_content.clone(),
            created_at: record.created_at.clone(),
        })
        .collect();
    let input_json = serde_json::to_string_pretty(&input_fixtures)?;
    fs::write(fixtures_dir.join("input.json"), input_json).with_context(|| "write input.json")?;

    println!(
        "Wrote fixture `{fixture_name}` from `{stream_jsonl}` with {} records",
        records.len()
    );
    Ok(())
}
