use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use base64::Engine;
use serde_json::Value;

pub fn prepare_turn_content_for_persist(session_id: &str, content_json: &str) -> Result<String> {
    let Ok(mut parsed) = serde_json::from_str::<Value>(content_json) else {
        return Ok(content_json.to_string());
    };

    let Some(item) = parsed.get_mut("item").and_then(Value::as_object_mut) else {
        return Ok(content_json.to_string());
    };
    let item_type = item.get("type").and_then(Value::as_str);
    if !matches!(item_type, Some("image_generation" | "imageGeneration")) {
        return Ok(content_json.to_string());
    }

    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .map(safe_filename)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let result = item
        .get("result")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    let source_path = item
        .get("saved_path")
        .or_else(|| item.get("savedPath"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from);

    let Some(path) = persist_image_payload(session_id, &item_id, source_path, result.as_deref())?
    else {
        return Ok(content_json.to_string());
    };

    item.remove("result");
    item.remove("savedPath");
    item.insert(
        "saved_path".to_string(),
        Value::String(path.to_string_lossy().to_string()),
    );

    Ok(serde_json::to_string(&parsed)?)
}

fn persist_image_payload(
    session_id: &str,
    item_id: &str,
    source_path: Option<PathBuf>,
    result: Option<&str>,
) -> Result<Option<PathBuf>> {
    let ext = source_path
        .as_deref()
        .and_then(path_ext)
        .or_else(|| result.and_then(data_url_ext))
        .unwrap_or("png");
    let dest_dir = crate::data_dir::generated_images_dir()?.join(safe_filename(session_id));
    fs::create_dir_all(&dest_dir).with_context(|| {
        format!(
            "Failed to create generated image dir {}",
            dest_dir.display()
        )
    })?;
    let dest_path = dest_dir.join(format!("{item_id}.{ext}"));

    if let Some(source) = source_path {
        if source.is_file() {
            if source != dest_path {
                fs::copy(&source, &dest_path).with_context(|| {
                    format!(
                        "Failed to copy generated image {} to {}",
                        source.display(),
                        dest_path.display()
                    )
                })?;
            }
            return Ok(Some(dest_path));
        }
    }

    let Some(result) = result else {
        return Ok(None);
    };
    let bytes = decode_image_result(result)?;
    fs::write(&dest_path, bytes)
        .with_context(|| format!("Failed to write generated image {}", dest_path.display()))?;
    Ok(Some(dest_path))
}

fn decode_image_result(result: &str) -> Result<Vec<u8>> {
    let encoded = result
        .split_once(',')
        .filter(|(prefix, _)| prefix.starts_with("data:image/"))
        .map(|(_, data)| data)
        .unwrap_or(result);

    base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .context("Invalid generated image base64")
}

fn data_url_ext(result: &str) -> Option<&'static str> {
    let prefix = result.split_once(',')?.0;
    if !prefix.starts_with("data:image/") {
        return None;
    }
    match prefix.strip_prefix("data:image/")?.split(';').next()? {
        "jpeg" | "jpg" => Some("jpg"),
        "gif" => Some("gif"),
        "webp" => Some("webp"),
        "png" => Some("png"),
        _ => None,
    }
}

fn path_ext(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("jpg"),
        "gif" => Some("gif"),
        "webp" => Some("webp"),
        "png" => Some("png"),
        _ => None,
    }
}

fn safe_filename(input: &str) -> String {
    input
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_result_and_copies_saved_image() {
        let _guard = crate::data_dir::TEST_ENV_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.png");
        fs::write(&source, b"png-bytes").unwrap();
        std::env::set_var("HELMOR_DATA_DIR", temp.path().join("helmor-data"));

        let content = serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "ig_1",
                "type": "image_generation",
                "result": "large-base64",
                "saved_path": source,
            }
        })
        .to_string();

        let prepared = prepare_turn_content_for_persist("session/1", &content).unwrap();
        let parsed: Value = serde_json::from_str(&prepared).unwrap();
        let item = parsed.get("item").unwrap();
        assert!(item.get("result").is_none());

        let saved_path = item.get("saved_path").and_then(Value::as_str).unwrap();
        assert!(saved_path.contains("generated-images/session_1/ig_1.png"));
        assert_eq!(fs::read(saved_path).unwrap(), b"png-bytes");

        std::env::remove_var("HELMOR_DATA_DIR");
    }

    #[test]
    fn writes_base64_when_saved_path_is_missing() {
        let _guard = crate::data_dir::TEST_ENV_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", temp.path().join("helmor-data"));

        let content = serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "ig_2",
                "type": "image_generation",
                "result": "cG5nLWJ5dGVz",
            }
        })
        .to_string();

        let prepared = prepare_turn_content_for_persist("session-2", &content).unwrap();
        let parsed: Value = serde_json::from_str(&prepared).unwrap();
        let saved_path = parsed
            .get("item")
            .and_then(|item| item.get("saved_path"))
            .and_then(Value::as_str)
            .unwrap();
        assert_eq!(fs::read(saved_path).unwrap(), b"png-bytes");

        std::env::remove_var("HELMOR_DATA_DIR");
    }
}
