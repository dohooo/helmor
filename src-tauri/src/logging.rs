//! Structured JSON logging with a single-file size-based ring.
//!
//! Two files per component in the data-dir `logs/` folder:
//!   `rust.jsonl`    — active, appended until it hits `MAX_BYTES`
//!   `rust.jsonl.1`  — previous segment, overwritten on each rotation
//!
//! Total disk use is bounded at `2 × MAX_BYTES` per component. No dates in
//! filenames, no background cleanup, no UTC/local races.
//!
//! Dev builds also print human-readable output to stderr.
//!
//! Level defaults:
//! - dev: `warn,helmor_lib=debug,helmor=debug` — app crates debug, deps warn.
//!   Keeps hyper/reqwest/rustls/h2 connection traces out of the stream.
//! - release: `info`.
//!
//! Override with `HELMOR_LOG`. Accepts either a bare level (`debug`, `info`, ...)
//! or a full `EnvFilter` directive list (e.g. `info,helmor_lib=trace,hyper=debug`).

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use tracing_subscriber::{
    fmt, fmt::time::ChronoLocal, fmt::MakeWriter, layer::SubscriberExt, util::SubscriberInitExt,
    EnvFilter, Layer,
};

/// Per-file size cap. `rust.jsonl` + `rust.jsonl.1` together never exceed 2×.
const MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Dev default: app crates at `debug`, everything else at `warn`.
/// Without the `warn` baseline, hyper/reqwest/rustls flood stderr with
/// per-connection traces (see `git::watcher` periodic fetches).
const DEV_DEFAULT_DIRECTIVES: &str = "warn,helmor_lib=debug,helmor=debug";

/// Release default: plain `info`.
const RELEASE_DEFAULT_DIRECTIVES: &str = "info";

/// Set up the global tracing subscriber.
///
/// Dev:  stderr (human-readable) + JSONL file.
/// Prod: JSONL file only.
/// Filter comes from `build_filter` (see module docs for defaults).
pub fn init(logs_dir: &Path) -> Result<()> {
    let is_dev = crate::data_dir::is_dev();

    fs::create_dir_all(logs_dir)
        .with_context(|| format!("create logs dir: {}", logs_dir.display()))?;

    let rust_layer = fmt::layer()
        .json()
        .flatten_event(true)
        .with_current_span(false)
        .with_span_list(false)
        .with_timer(ChronoLocal::default())
        .with_writer(SizeRingAppender::new(logs_dir, "rust.jsonl", MAX_BYTES)?)
        .with_filter(build_filter(is_dev));

    let stderr_layer = is_dev.then(|| {
        fmt::layer()
            .with_writer(std::io::stderr)
            .with_ansi(true)
            .with_timer(ChronoLocal::default())
            .with_filter(build_filter(is_dev))
    });

    tracing_subscriber::registry()
        .with(rust_layer)
        .with(stderr_layer)
        .init();

    Ok(())
}

/// Returns the resolved `logs/` directory path. Convenience for callers that
/// need to pass it to the sidecar via `HELMOR_LOG_DIR`.
pub fn logs_dir() -> Result<PathBuf> {
    crate::data_dir::logs_dir()
}

/// Single-file ring appender. When the active file exceeds `max_bytes`, it is
/// renamed to `<name>.1` (replacing any prior backup) and a fresh active file
/// is opened. Rotation is best-effort — if `rename` fails we keep appending.
pub struct SizeRingAppender {
    primary: PathBuf,
    backup: PathBuf,
    max_bytes: u64,
    state: Mutex<AppenderState>,
}

struct AppenderState {
    file: File,
    written: u64,
}

impl SizeRingAppender {
    fn new(logs_dir: &Path, name: &str, max_bytes: u64) -> Result<Self> {
        let primary = logs_dir.join(name);
        let backup = logs_dir.join(format!("{name}.1"));
        let file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&primary)
            .with_context(|| format!("open log file: {}", primary.display()))?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            primary,
            backup,
            max_bytes,
            state: Mutex::new(AppenderState { file, written }),
        })
    }

    fn rotate(&self, state: &mut AppenderState) -> io::Result<()> {
        let _ = fs::remove_file(&self.backup);
        let _ = fs::rename(&self.primary, &self.backup);
        let file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.primary)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        state.file = file;
        state.written = written;
        Ok(())
    }
}

impl io::Write for &SizeRingAppender {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut state = self
            .state
            .lock()
            .map_err(|e| io::Error::other(format!("log lock poisoned: {e}")))?;

        if state.written.saturating_add(buf.len() as u64) > self.max_bytes {
            // Best-effort; if rotation fails we keep appending and retry later.
            let _ = self.rotate(&mut state);
        }

        let n = state.file.write(buf)?;
        state.written = state.written.saturating_add(n as u64);
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|e| io::Error::other(format!("log lock poisoned: {e}")))?;
        state.file.flush()
    }
}

impl<'a> MakeWriter<'a> for SizeRingAppender {
    type Writer = &'a SizeRingAppender;
    fn make_writer(&'a self) -> Self::Writer {
        self
    }
}

/// Build a fresh `EnvFilter`. `HELMOR_LOG` wins when set and parses; otherwise
/// falls back to the build-profile default. Called once per layer because
/// `EnvFilter` is not `Clone`.
fn build_filter(is_dev: bool) -> EnvFilter {
    std::env::var("HELMOR_LOG")
        .ok()
        .and_then(|s| EnvFilter::try_new(&s).ok())
        .unwrap_or_else(|| EnvFilter::new(default_directives(is_dev)))
}

fn default_directives(is_dev: bool) -> &'static str {
    if is_dev {
        DEV_DEFAULT_DIRECTIVES
    } else {
        RELEASE_DEFAULT_DIRECTIVES
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn dev_default_allows_helmor_debug_but_caps_deps_at_warn() {
        // Dev default: helmor crates DEBUG, everything else WARN.
        // max_level_hint reflects the most permissive directive.
        let f = EnvFilter::new(default_directives(true));
        assert_eq!(f.max_level_hint(), Some(tracing::Level::DEBUG.into()));
    }

    #[test]
    fn release_default_is_info() {
        let f = EnvFilter::new(default_directives(false));
        assert_eq!(f.max_level_hint(), Some(tracing::Level::INFO.into()));
    }

    #[test]
    fn appender_creates_primary_and_appends() {
        let tmp = tempfile::tempdir().unwrap();
        let appender = SizeRingAppender::new(tmp.path(), "rust.jsonl", 1024).unwrap();
        let primary = tmp.path().join("rust.jsonl");
        assert!(primary.exists());

        (&appender).write_all(b"a\n").unwrap();
        (&appender).write_all(b"b\n").unwrap();
        (&appender).flush().unwrap();

        let mut s = String::new();
        File::open(&primary)
            .unwrap()
            .read_to_string(&mut s)
            .unwrap();
        assert_eq!(s, "a\nb\n");
    }

    #[test]
    fn appender_rotates_when_exceeding_max_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        // 16-byte cap: first line fits, second line triggers rotation.
        let appender = SizeRingAppender::new(tmp.path(), "rust.jsonl", 16).unwrap();
        let primary = tmp.path().join("rust.jsonl");
        let backup = tmp.path().join("rust.jsonl.1");

        (&appender).write_all(b"0123456789abcd\n").unwrap(); // 15 bytes
        assert!(!backup.exists(), "first write should not rotate");

        (&appender).write_all(b"second\n").unwrap();
        assert!(backup.exists(), "second write should trigger rotation");

        let mut old = String::new();
        File::open(&backup)
            .unwrap()
            .read_to_string(&mut old)
            .unwrap();
        assert_eq!(old, "0123456789abcd\n");

        let mut new_ = String::new();
        File::open(&primary)
            .unwrap()
            .read_to_string(&mut new_)
            .unwrap();
        assert_eq!(new_, "second\n");
    }

    #[test]
    fn second_rotation_overwrites_previous_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let appender = SizeRingAppender::new(tmp.path(), "rust.jsonl", 8).unwrap();
        let backup = tmp.path().join("rust.jsonl.1");

        (&appender).write_all(b"first\n").unwrap();
        (&appender).write_all(b"second\n").unwrap(); // rotates: backup = "first\n"
        (&appender).write_all(b"third\n").unwrap(); // rotates: backup = "second\n"

        let mut s = String::new();
        File::open(&backup).unwrap().read_to_string(&mut s).unwrap();
        assert_eq!(s, "second\n", "backup keeps only the most recent segment");

        // Only two files ever exist.
        let entries: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name()))
            .collect();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn appender_picks_up_existing_file_size() {
        let tmp = tempfile::tempdir().unwrap();
        let primary = tmp.path().join("rust.jsonl");
        fs::write(&primary, b"preexisting\n").unwrap();

        let appender = SizeRingAppender::new(tmp.path(), "rust.jsonl", 20).unwrap();
        // "preexisting\n" = 12 bytes; next write of 10 bytes should trigger rotate.
        (&appender).write_all(b"abcdefghi\n").unwrap();

        let backup = tmp.path().join("rust.jsonl.1");
        assert!(backup.exists(), "rotation should honor starting-file size");
        let mut s = String::new();
        File::open(&backup).unwrap().read_to_string(&mut s).unwrap();
        assert_eq!(s, "preexisting\n");
    }
}
