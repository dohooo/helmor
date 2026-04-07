//! Snapshot tests for the message pipeline.
//!
//! # Strategy
//!
//! Each fixture under `tests/fixtures/pipeline/<name>/` contains:
//! - `input.json`: raw `HistoricalRecord[]` (the producer side, captured
//!   from real `session_messages` rows in the SQLite DB).
//! - `expected.json`: the `ThreadMessageLike[]` produced by running the
//!   current pipeline on `input.json` (the consumer side, captured from
//!   the live frontend output).
//!
//! On every test run we re-run the pipeline against `input.json` and
//! diff against `expected.json`. Any drift in the adapter, collapse,
//! or classification logic will fail the corresponding fixture test.
//!
//! # Updating fixtures
//!
//! When a pipeline change is intentional, regenerate fixtures with:
//!
//! ```sh
//! UPDATE_SNAPSHOTS=1 cargo test --test pipeline_snapshots
//! ```
//!
//! This rewrites every `expected.json` from the current pipeline output.
//! Review the diff carefully before committing.
//!
//! # Generating new fixtures from the live DB
//!
//! ```sh
//! cargo run --bin gen_pipeline_fixture -- <session_id> <fixture_name>
//! ```

use std::fs;
use std::path::{Path, PathBuf};

use helmor_lib::pipeline::{types::HistoricalRecord, MessagePipeline};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Fixture file format
// ---------------------------------------------------------------------------

/// Serializable form of `HistoricalRecord` (the producer-side input).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct HistoricalRecordFixture {
    id: String,
    role: String,
    content: String,
    content_is_json: bool,
    parsed_content: Option<serde_json::Value>,
    created_at: String,
}

impl HistoricalRecordFixture {
    fn into_record(self) -> HistoricalRecord {
        HistoricalRecord {
            id: self.id,
            role: self.role,
            content: self.content,
            content_is_json: self.content_is_json,
            parsed_content: self.parsed_content,
            created_at: self.created_at,
        }
    }
}

// ---------------------------------------------------------------------------
// Fixture discovery
// ---------------------------------------------------------------------------

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("pipeline")
}

fn discover_fixtures() -> Vec<PathBuf> {
    let dir = fixtures_dir();
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).expect("read fixtures dir") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if path.is_dir() && path.join("input.json").is_file() {
            out.push(path);
        }
    }
    out.sort();
    out
}

// ---------------------------------------------------------------------------
// Snapshot runner
// ---------------------------------------------------------------------------

fn load_input(fixture: &Path) -> Vec<HistoricalRecord> {
    let raw = fs::read_to_string(fixture.join("input.json"))
        .unwrap_or_else(|e| panic!("read input.json for {fixture:?}: {e}"));
    let fixtures: Vec<HistoricalRecordFixture> = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("parse input.json for {fixture:?}: {e}"));
    fixtures.into_iter().map(|f| f.into_record()).collect()
}

fn run_pipeline(records: &[HistoricalRecord]) -> serde_json::Value {
    let messages = MessagePipeline::convert_historical(records);
    serde_json::to_value(&messages).expect("serialize pipeline output")
}

fn read_expected(fixture: &Path) -> Option<serde_json::Value> {
    let path = fixture.join("expected.json");
    if !path.is_file() {
        return None;
    }
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read expected.json for {fixture:?}: {e}"));
    Some(
        serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("parse expected.json for {fixture:?}: {e}")),
    )
}

fn write_expected(fixture: &Path, value: &serde_json::Value) {
    let path = fixture.join("expected.json");
    let pretty = serde_json::to_string_pretty(value).expect("pretty serialize");
    fs::write(&path, pretty).unwrap_or_else(|e| panic!("write expected.json: {e}"));
}

fn diff_summary(expected: &serde_json::Value, actual: &serde_json::Value) -> String {
    // Simple line-level diff between pretty-printed JSON.
    let expected_pretty = serde_json::to_string_pretty(expected).unwrap_or_default();
    let actual_pretty = serde_json::to_string_pretty(actual).unwrap_or_default();
    let expected_lines: Vec<&str> = expected_pretty.lines().collect();
    let actual_lines: Vec<&str> = actual_pretty.lines().collect();

    let mut out = String::new();
    out.push_str(&format!(
        "Expected {} lines, actual {} lines\n",
        expected_lines.len(),
        actual_lines.len()
    ));

    let mut shown = 0;
    let max = expected_lines.len().max(actual_lines.len());
    for i in 0..max {
        let e = expected_lines.get(i).copied().unwrap_or("<EOF>");
        let a = actual_lines.get(i).copied().unwrap_or("<EOF>");
        if e != a {
            out.push_str(&format!("  L{i:>5}: -{e}\n"));
            out.push_str(&format!("         +{a}\n"));
            shown += 1;
            if shown >= 12 {
                out.push_str("  ... (truncated)\n");
                break;
            }
        }
    }
    out
}

fn run_fixture(fixture: &Path) {
    let name = fixture.file_name().and_then(|s| s.to_str()).unwrap_or("?");
    let records = load_input(fixture);
    let actual = run_pipeline(&records);

    let update_mode = std::env::var("UPDATE_SNAPSHOTS").is_ok();

    if update_mode {
        write_expected(fixture, &actual);
        eprintln!("[UPDATED] {name} ({} records)", records.len());
        return;
    }

    let expected = match read_expected(fixture) {
        Some(v) => v,
        None => {
            // First run — create the snapshot.
            write_expected(fixture, &actual);
            eprintln!("[CREATED] {name} ({} records)", records.len());
            return;
        }
    };

    if expected != actual {
        let diff = diff_summary(&expected, &actual);
        panic!(
            "Snapshot mismatch for fixture `{name}` ({} records).\n\
             Run `UPDATE_SNAPSHOTS=1 cargo test --test pipeline_snapshots` \
             to accept the new output.\n\n{diff}",
            records.len()
        );
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn pipeline_snapshots_match() {
    let fixtures = discover_fixtures();
    if fixtures.is_empty() {
        panic!(
            "No fixtures found in {:?}. Generate fixtures first with the \
             gen_pipeline_fixture binary.",
            fixtures_dir()
        );
    }
    eprintln!("Running {} pipeline fixture(s)", fixtures.len());
    for fixture in fixtures {
        run_fixture(&fixture);
    }
}

#[test]
fn pipeline_output_is_deterministic() {
    // Same input should produce identical output across two runs.
    let fixtures = discover_fixtures();
    if fixtures.is_empty() {
        return; // Tested above
    }
    for fixture in fixtures {
        let records = load_input(&fixture);
        let first = run_pipeline(&records);
        let second = run_pipeline(&records);
        assert_eq!(
            first,
            second,
            "Pipeline output is non-deterministic for fixture {:?}",
            fixture.file_name()
        );
    }
}
