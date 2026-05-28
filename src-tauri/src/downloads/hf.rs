//! HuggingFace `models/{repo}` manifest fetcher. Best-effort —
//! callers downgrade to `Content-Length` + no integrity verification
//! when the manifest can't be fetched (offline, private repo, etc).

use std::collections::HashMap;

use anyhow::{Context, Result};
use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct HfManifest {
    pub per_file: HashMap<String, HfFileInfo>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct HfFileInfo {
    pub size: Option<u64>,
    pub sha256: Option<String>,
}

impl HfManifest {
    /// Hit `GET /api/models/{repo}` and extract the `siblings` array
    /// down to `{ size, sha256 }` per file. Resilient: returns Err
    /// only on hard transport failures; missing fields per sibling
    /// just leave the maps empty.
    pub async fn fetch(client: &reqwest::Client, repo: &str) -> Result<Self> {
        let url = format!("https://huggingface.co/api/models/{repo}");
        let raw = client
            .get(&url)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?
            .error_for_status()
            .with_context(|| format!("HF API {url}"))?
            .json::<serde_json::Value>()
            .await
            .with_context(|| format!("decode HF manifest for {url}"))?;
        let siblings = raw
            .get("siblings")
            .and_then(|s| s.as_array())
            .cloned()
            .unwrap_or_default();
        let mut per_file = HashMap::new();
        for sibling in siblings {
            let Some(name) = sibling
                .get("rfilename")
                .and_then(|n| n.as_str())
                .map(str::to_owned)
            else {
                continue;
            };
            let info = HfFileInfo {
                size: sibling
                    .get("size")
                    .and_then(|s| s.as_u64())
                    .or_else(|| sibling.pointer("/lfs/size").and_then(|s| s.as_u64())),
                sha256: sibling
                    .pointer("/lfs/sha256")
                    .and_then(|s| s.as_str())
                    .map(str::to_owned),
            };
            per_file.insert(name, info);
        }
        Ok(Self { per_file })
    }
}
