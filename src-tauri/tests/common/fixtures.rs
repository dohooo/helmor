//! Real-data fixture loader (used by `pipeline_fixtures.rs`).
//!
//! Reads `tests/fixtures/pipeline/<name>/input.json` and produces
//! `Vec<HistoricalRecord>`. Accepts the legacy `content_is_json` field via
//! `#[serde(default, rename)]` for fixtures captured before the
//! user_prompt migration; the field is ignored on read since we now
//! always derive `parsed_content` from `content`.

use std::fs;
use std::path::{Path, PathBuf};

use helmor_lib::pipeline::types::HistoricalRecord;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoricalRecordFixture {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub parsed_content: Option<Value>,
    pub created_at: String,
    /// Legacy field — kept for deserialization of old fixtures, ignored.
    #[serde(default, rename = "content_is_json")]
    pub _legacy_content_is_json: Option<bool>,
}

impl HistoricalRecordFixture {
    pub fn into_record(self) -> HistoricalRecord {
        let parsed_content = self
            .parsed_content
            .or_else(|| serde_json::from_str(&self.content).ok());
        HistoricalRecord {
            id: self.id,
            role: self
                .role
                .parse()
                .unwrap_or_else(|e| panic!("fixture has invalid role: {e}")),
            content: self.content,
            parsed_content,
            created_at: self.created_at,
            // Real-data fixtures predate the author seam; none carry an author.
            author_id: None,
        }
    }
}

pub fn load_fixture(input_json_path: &Path) -> Vec<HistoricalRecord> {
    let raw = fs::read_to_string(input_json_path)
        .unwrap_or_else(|e| panic!("read {input_json_path:?}: {e}"));
    let fixtures: Vec<HistoricalRecordFixture> =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {input_json_path:?}: {e}"));
    fixtures.into_iter().map(|f| f.into_record()).collect()
}

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}
