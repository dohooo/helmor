//! Local-disk cache for forge account avatars.
//!
//! Each remote avatar URL maps to a single file in
//! [`crate::data_dir::avatar_cache_dir`] under `<sha256(url)>.<ext>`.
//! Once downloaded the file lives on disk forever (until the user
//! wipes the data dir), so navigating between pages stops re-issuing
//! HTTP fetches and re-running image decode.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use sha2::{Digest, Sha256};

use crate::data_dir::avatar_cache_dir;

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_BYTES: usize = 4 * 1024 * 1024; // 4 MiB hard cap; real avatars are <100KB

/// Resolve `url` to a local file path, downloading on first call.
/// Idempotent and safe to call concurrently — concurrent winners just
/// re-write the same bytes; readers either see the old path or the new
/// one (atomic rename).
pub fn cached_avatar_path(url: &str) -> Result<PathBuf> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("empty avatar url"));
    }

    let dir = avatar_cache_dir()?;
    let stem = url_hash(trimmed);

    if let Some(existing) = find_existing(&dir, &stem)? {
        return Ok(existing);
    }

    let (bytes, ext) = download(trimmed)?;
    let final_path = dir.join(format!("{stem}.{ext}"));
    write_atomic(&final_path, &bytes)?;
    Ok(final_path)
}

fn url_hash(url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    let digest = hasher.finalize();
    hex_encode(&digest)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn find_existing(dir: &std::path::Path, stem: &str) -> Result<Option<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(it) => it,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(anyhow::Error::from(error)
                .context(format!("read avatar cache dir {}", dir.display())))
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s == stem)
            .unwrap_or(false)
            && path.is_file()
        {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn download(url: &str) -> Result<(Vec<u8>, &'static str)> {
    let client = reqwest::blocking::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .context("build reqwest client")?;
    let response = client
        .get(url)
        .send()
        .with_context(|| format!("GET {url}"))?
        .error_for_status()
        .with_context(|| format!("non-2xx status from {url}"))?;

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase());
    let ext = ext_from_content_type(content_type.as_deref()).unwrap_or("png");

    let bytes = response.bytes().with_context(|| format!("body of {url}"))?;
    if bytes.len() > MAX_BYTES {
        return Err(anyhow!(
            "avatar payload too large ({} bytes, cap {MAX_BYTES})",
            bytes.len()
        ));
    }
    Ok((bytes.to_vec(), ext))
}

fn ext_from_content_type(content_type: Option<&str>) -> Option<&'static str> {
    let value = content_type?;
    let mime = value.split(';').next()?.trim();
    Some(match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        _ => return None,
    })
}

fn write_atomic(final_path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let dir = final_path
        .parent()
        .ok_or_else(|| anyhow!("avatar path has no parent: {}", final_path.display()))?;
    let tmp_name = format!(
        ".{}.{}.tmp",
        final_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("avatar"),
        std::process::id()
    );
    let tmp_path = dir.join(tmp_name);
    {
        let mut tmp = fs::File::create(&tmp_path)
            .with_context(|| format!("create temp avatar {}", tmp_path.display()))?;
        tmp.write_all(bytes)
            .with_context(|| format!("write avatar bytes to {}", tmp_path.display()))?;
        tmp.sync_all().ok();
    }
    fs::rename(&tmp_path, final_path)
        .with_context(|| format!("rename {} -> {}", tmp_path.display(), final_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_hash_is_stable_and_64_hex_chars() {
        let h = url_hash("https://avatars.githubusercontent.com/u/1?v=4");
        assert_eq!(h.len(), 64);
        assert!(h
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
        assert_eq!(h, url_hash("https://avatars.githubusercontent.com/u/1?v=4"));
        assert_ne!(h, url_hash("https://avatars.githubusercontent.com/u/2?v=4"));
    }

    #[test]
    fn ext_from_content_type_handles_common_image_mimes() {
        assert_eq!(ext_from_content_type(Some("image/png")), Some("png"));
        assert_eq!(
            ext_from_content_type(Some("image/jpeg; charset=binary")),
            Some("jpg")
        );
        assert_eq!(ext_from_content_type(Some("image/webp")), Some("webp"));
        assert_eq!(ext_from_content_type(Some("text/html")), None);
        assert_eq!(ext_from_content_type(None), None);
    }

    #[test]
    fn cached_avatar_path_rejects_empty_url() {
        assert!(cached_avatar_path("   ").is_err());
    }

    #[test]
    fn write_atomic_creates_file_with_payload() {
        let _lock = crate::data_dir::TEST_ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("foo.png");
        write_atomic(&path, b"hello").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"hello");
    }

    #[test]
    fn find_existing_locates_file_with_any_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let stem = "abc123";
        let path = tmp.path().join(format!("{stem}.png"));
        fs::write(&path, b"x").unwrap();
        let found = find_existing(tmp.path(), stem).unwrap().unwrap();
        assert_eq!(found, path);
    }
}
