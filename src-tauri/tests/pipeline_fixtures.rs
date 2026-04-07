//! Real-data fixture tests for the message pipeline.
//!
//! Each fixture under `tests/fixtures/pipeline/<name>/input.json` is a
//! `Vec<HistoricalRecord>` captured from a real session in the SQLite DB
//! (via the `gen_pipeline_fixture` binary). On every test run we re-run
//! `MessagePipeline::convert_historical` and snapshot the output via
//! `insta::assert_yaml_snapshot!`. Drift in the adapter, collapse, child
//! grouping, or merging logic fails the corresponding fixture.
//!
//! # Fidelity
//!
//! Unlike `pipeline_scenarios.rs` (which uses a normalized form to keep
//! handcrafted scenarios short), this file snapshots the **raw**
//! `Vec<ThreadMessageLike>` because real-data fixtures want full content
//! fidelity — exact tool args, exact text, exact IDs from the source
//! session. Snapshot drift in any of these is meaningful.
//!
//! # Adding a new fixture
//!
//! ```sh
//! cargo run --bin gen_pipeline_fixture -- <session_id> <fixture_name>
//! ```
//!
//! Then run the tests once with `INSTA_UPDATE=always` to create the
//! corresponding `.snap` file.
//!
//! # Updating existing snapshots after an intentional pipeline change
//!
//! ```sh
//! INSTA_UPDATE=always cargo test --test pipeline_fixtures
//! # or, with the insta CLI:
//! cargo insta review
//! ```
//!
//! Review every diff carefully before committing — the .snap files are
//! the source of truth for what each real session should render as.

mod common;

use common::*;
use insta::{assert_yaml_snapshot, glob};

#[test]
fn pipeline_fixtures() {
    // glob! discovers every input.json under fixtures/pipeline/, runs the
    // pipeline on it, and writes one snapshot file per fixture. The path
    // segment after `pipeline/` becomes the snapshot suffix.
    glob!("fixtures/pipeline/*/input.json", |path| {
        let records = load_fixture(path);
        let messages = MessagePipeline::convert_historical(&records);
        assert_yaml_snapshot!(messages);
    });
}

#[test]
fn pipeline_output_is_deterministic() {
    // Same input must produce identical output across two runs. Catches
    // accidental introduction of HashMap iteration / random IDs / etc.
    glob!("fixtures/pipeline/*/input.json", |path| {
        let records = load_fixture(path);
        let first = MessagePipeline::convert_historical(&records);
        let second = MessagePipeline::convert_historical(&records);
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::to_value(&second).unwrap(),
            "Pipeline output is non-deterministic for fixture {path:?}"
        );
    });
}
