//! Generate a pipeline snapshot fixture from a real session in the SQLite DB.
//!
//! Usage:
//!   cargo run --bin gen_pipeline_fixture -- <session_id> <fixture_name> [--limit N]
//!
//! Reads `session_messages` rows for the given session and writes them to
//! `tests/fixtures/pipeline/<fixture_name>/input.json`. The expected output
//! is captured separately by `pipeline_fixtures.rs` via insta snapshots
//! (`tests/snapshots/pipeline_fixtures__*.snap`) — this binary only
//! produces the input side.
//!
//! Use `--limit N` to truncate the input to the first N records, useful
//! for keeping fixture files small while still testing realistic data.
//!
//! The DB path resolves the same way the main app does: `~/helmor` for
//! release builds, `~/helmor-dev` for debug builds, or `HELMOR_DATA_DIR`
//! when set.

use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use helmor_lib::pipeline::types::HistoricalRecord;
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
    let mut positional: Vec<&str> = Vec::new();
    let mut limit: Option<usize> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--limit" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("--limit requires a value");
                    return ExitCode::from(2);
                }
                match args[i].parse::<usize>() {
                    Ok(n) => limit = Some(n),
                    Err(_) => {
                        eprintln!("--limit must be a positive integer");
                        return ExitCode::from(2);
                    }
                }
            }
            _ => positional.push(&args[i]),
        }
        i += 1;
    }

    if positional.len() != 2 {
        eprintln!("Usage: gen_pipeline_fixture <session_id> <fixture_name> [--limit N]");
        eprintln!();
        eprintln!("Examples:");
        eprintln!(
            "  cargo run --bin gen_pipeline_fixture -- \\\n        \
             2d94410d-233d-4763-b414-dbe0da119abe large_collapse --limit 80"
        );
        return ExitCode::from(2);
    }

    let session_id = positional[0];
    let fixture_name = positional[1];

    match run(session_id, fixture_name, limit) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(session_id: &str, fixture_name: &str, limit: Option<usize>) -> Result<()> {
    let mut records = load_session_records(session_id)
        .with_context(|| format!("loading session_messages for {session_id}"))?;

    if records.is_empty() {
        anyhow::bail!("No messages found for session {session_id}");
    }

    let original_len = records.len();
    if let Some(n) = limit {
        records.truncate(n);
    }

    let fixtures_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("pipeline")
        .join(fixture_name);
    fs::create_dir_all(&fixtures_dir)
        .with_context(|| format!("create fixture dir {fixtures_dir:?}"))?;

    // Write input.json (raw producer-side data)
    let input_fixtures: Vec<HistoricalRecordFixture> = records
        .iter()
        .map(|r| HistoricalRecordFixture {
            id: r.id.clone(),
            role: r.role.as_str().to_string(),
            content: r.content.clone(),
            parsed_content: r.parsed_content.clone(),
            created_at: r.created_at.clone(),
        })
        .collect();
    let input_json = serde_json::to_string_pretty(&input_fixtures)?;
    fs::write(fixtures_dir.join("input.json"), input_json).with_context(|| "write input.json")?;

    let suffix = if limit.is_some() {
        format!(" (truncated from {original_len})")
    } else {
        String::new()
    };
    println!(
        "Wrote fixture `{fixture_name}` with {} input records{suffix}",
        records.len()
    );
    println!("  {}", fixtures_dir.display());
    println!(
        "Next: run `INSTA_UPDATE=always cargo test --test pipeline_fixtures` \
         to capture the snapshot, then `cargo insta review` to confirm."
    );

    Ok(())
}

fn load_session_records(session_id: &str) -> Result<Vec<HistoricalRecord>> {
    let db_path = helmor_lib::data_dir::db_path()?;
    let conn =
        rusqlite::Connection::open(&db_path).with_context(|| format!("open db at {db_path:?}"))?;

    let mut stmt = conn.prepare(
        "SELECT id, role, content, created_at \
         FROM session_messages \
         WHERE session_id = ?1 \
         ORDER BY sent_at ASC, rowid ASC",
    )?;

    let rows = stmt.query_map([session_id], |row| {
        let id: String = row.get(0)?;
        let role: helmor_lib::pipeline::types::MessageRole = row.get(1)?;
        let content: String = row.get(2)?;
        let created_at: String = row.get(3)?;
        Ok((id, role, content, created_at))
    })?;

    let mut records = Vec::new();
    for row in rows {
        let (id, role, content, created_at) = row?;
        let parsed_content = serde_json::from_str(&content).ok();
        records.push(HistoricalRecord {
            id,
            role,
            content,
            parsed_content,
            created_at,
        });
    }

    Ok(records)
}
