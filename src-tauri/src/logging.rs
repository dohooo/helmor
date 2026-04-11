//! Structured JSON logging with daily rotation.
//!
//! Files: `rust-{error,info,debug}.YYYY-MM-DD.jsonl` under the data-dir `logs/` folder.
//! Dev builds also print human-readable output to stderr.
//! Old log files are gzip-compressed on startup; files older than 7 days are purged.
//!
//! Level defaults: `debug` (dev), `info` (release). Override with `HELMOR_LOG=debug|info|error`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::{
    filter::LevelFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt, Layer,
};

/// Set up the global tracing subscriber.
///
/// Dev:  stderr (human-readable) + three JSONL files at `debug` level.
/// Prod: three JSONL files only, default `info` (override via `HELMOR_LOG`).
pub fn init(logs_dir: &Path) -> Result<()> {
    let is_dev = crate::data_dir::is_dev();
    let level = resolve_level(is_dev);

    // Macro avoids repeating the json format config for each file layer.
    // Each invocation produces the same concrete type so the registry chain compiles.
    macro_rules! file_layer {
        ($prefix:literal, $level:expr) => {{
            let appender = RollingFileAppender::builder()
                .rotation(Rotation::DAILY)
                .filename_prefix($prefix)
                .filename_suffix("jsonl")
                .max_log_files(7)
                .build(logs_dir)
                .context(concat!("log appender: ", $prefix))?;
            fmt::layer()
                .json()
                .flatten_event(true)
                .with_current_span(false)
                .with_span_list(false)
                .with_writer(appender)
                .with_filter($level)
        }};
    }

    let stderr_layer = is_dev.then(|| {
        fmt::layer()
            .with_writer(std::io::stderr)
            .with_ansi(true)
            .with_filter(level)
    });

    tracing_subscriber::registry()
        .with(file_layer!("rust-error", LevelFilter::ERROR))
        .with(file_layer!("rust-info", LevelFilter::INFO))
        .with(file_layer!("rust-debug", level))
        .with(stderr_layer)
        .init();

    Ok(())
}

/// Compress yesterday's `.jsonl` files and delete `.jsonl.gz` older than 7 days.
/// Run once on startup, typically from a background thread.
pub fn cleanup(logs_dir: &Path) {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let cutoff = (chrono::Local::now() - chrono::Duration::days(7))
        .format("%Y-%m-%d")
        .to_string();

    let entries = match fs::read_dir(logs_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };

        // Compress non-today .jsonl -> .jsonl.gz
        if name.ends_with(".jsonl") && !name.contains(&today) {
            if let Err(e) = gzip(&path) {
                tracing::warn!(file = %path.display(), "log compression failed: {e}");
            }
            continue;
        }

        // Purge old .jsonl.gz beyond retention
        if name.ends_with(".jsonl.gz")
            && extract_date(name).is_some_and(|d| d < cutoff.as_str())
        {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Returns the resolved `logs/` directory path. Convenience for callers that
/// need to pass it to the sidecar via `HELMOR_LOG_DIR`.
pub fn logs_dir() -> Result<PathBuf> {
    crate::data_dir::logs_dir()
}

// --- helpers ----------------------------------------------------------------

fn resolve_level(is_dev: bool) -> LevelFilter {
    std::env::var("HELMOR_LOG")
        .ok()
        .and_then(|s| match s.to_lowercase().as_str() {
            "trace" => Some(LevelFilter::TRACE),
            "debug" => Some(LevelFilter::DEBUG),
            "info" => Some(LevelFilter::INFO),
            "warn" => Some(LevelFilter::WARN),
            "error" => Some(LevelFilter::ERROR),
            _ => None,
        })
        .unwrap_or(if is_dev {
            LevelFilter::DEBUG
        } else {
            LevelFilter::INFO
        })
}

fn gzip(src: &Path) -> Result<()> {
    use flate2::write::GzEncoder;
    use flate2::Compression;

    let dst = append_gz(src);
    let input = fs::File::open(src).with_context(|| format!("open {}", src.display()))?;
    let output = fs::File::create(&dst).with_context(|| format!("create {}", dst.display()))?;

    let mut enc = GzEncoder::new(output, Compression::default());
    io::copy(&mut io::BufReader::new(input), &mut enc)?;
    enc.finish()?;

    fs::remove_file(src)?;
    Ok(())
}

fn append_gz(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".gz");
    PathBuf::from(s)
}

/// Extract the `YYYY-MM-DD` segment from a log filename like `rust-error.2026-04-11.jsonl.gz`.
fn extract_date(filename: &str) -> Option<&str> {
    filename.split('.').find(|s| {
        s.len() == 10
            && s.as_bytes().get(4) == Some(&b'-')
            && s.as_bytes().get(7) == Some(&b'-')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_date_from_jsonl() {
        assert_eq!(
            extract_date("rust-error.2026-04-11.jsonl"),
            Some("2026-04-11")
        );
    }

    #[test]
    fn extract_date_from_gz() {
        assert_eq!(
            extract_date("sidecar-debug.2026-01-01.jsonl.gz"),
            Some("2026-01-01")
        );
    }

    #[test]
    fn extract_date_returns_none_for_bad_name() {
        assert_eq!(extract_date("random-file.txt"), None);
    }

    #[test]
    fn resolve_level_defaults_debug_in_dev() {
        // In test (debug) builds, default should be DEBUG
        let level = resolve_level(true);
        assert_eq!(level, LevelFilter::DEBUG);
    }

    #[test]
    fn resolve_level_defaults_info_in_prod() {
        let level = resolve_level(false);
        assert_eq!(level, LevelFilter::INFO);
    }
}
