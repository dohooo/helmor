//! `Content-Length`-framed JSON message codec.
//!
//! Mirrors LSP's framing exactly so anyone familiar with the protocol
//! reads this without surprise. Each message on the wire is:
//!
//! ```text
//! Content-Length: <byte length of body>\r\n
//! Content-Type: application/json\r\n    (optional)
//! \r\n
//! <UTF-8 JSON body>
//! ```
//!
//! Why headers instead of `\n`-delimited JSON like the sidecar uses:
//! the sidecar's events are single-direction streaming from a child
//! Helmor controls. Over SSH the peer is unknown territory and may
//! emit log noise on stderr that gets interleaved; framed reads
//! tolerate partial-line garbage and preserve binary-safety for
//! future payloads (image bytes, diffs with embedded newlines, …)
//! without ad-hoc escaping.

use std::fmt;
use std::io::{BufRead, Write};

use serde::de::DeserializeOwned;
use serde::Serialize;

/// Cap on a single message body. 16 MiB is well past anything we
/// expect to ferry (largest realistic single payload is a chunked
/// streaming event ~64 KiB; a per-RPC file diff ~1 MiB), and short
/// enough that a malformed `Content-Length` can't OOM the process.
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub enum FrameError {
    Eof,
    Io(std::io::Error),
    MalformedHeader(String),
    MissingContentLength,
    BodyTooLarge(usize, usize),
    Json(serde_json::Error),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Eof => write!(f, "eof while reading frame"),
            Self::Io(err) => write!(f, "io error: {err}"),
            Self::MalformedHeader(header) => write!(f, "malformed header `{header}`"),
            Self::MissingContentLength => write!(f, "missing Content-Length header"),
            Self::BodyTooLarge(actual, cap) => {
                write!(f, "body length {actual} exceeds {cap}-byte cap")
            }
            Self::Json(err) => write!(f, "json decode failed: {err}"),
        }
    }
}

impl std::error::Error for FrameError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(err) => Some(err),
            Self::Json(err) => Some(err),
            _ => None,
        }
    }
}

impl From<std::io::Error> for FrameError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<serde_json::Error> for FrameError {
    fn from(err: serde_json::Error) -> Self {
        Self::Json(err)
    }
}

/// Read one framed message off `reader` and deserialise it as `T`.
/// Returns `FrameError::Eof` on clean EOF so callers can distinguish
/// "peer closed cleanly" from "stream errored mid-message".
pub fn read_frame<R, T>(reader: &mut R) -> Result<T, FrameError>
where
    R: BufRead,
    T: DeserializeOwned,
{
    let mut content_length: Option<usize> = None;

    // Header phase: read until the blank line that terminates headers.
    // Each header line is `Name: value\r\n`. A `\r\n` on its own ends
    // the block.
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            // Peer closed before we got *any* header. EOF is the
            // correct signal — not an error.
            if content_length.is_none() {
                return Err(FrameError::Eof);
            }
            // Closed mid-header is a malformed message.
            return Err(FrameError::MalformedHeader(line));
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        let Some((name, value)) = trimmed.split_once(':') else {
            return Err(FrameError::MalformedHeader(trimmed.to_string()));
        };
        if name.eq_ignore_ascii_case("Content-Length") {
            let parsed: usize = value
                .trim()
                .parse()
                .map_err(|_| FrameError::MalformedHeader(trimmed.to_string()))?;
            content_length = Some(parsed);
        }
        // Other headers (e.g. `Content-Type: application/json`) are
        // accepted and ignored. LSP's pattern.
    }

    let length = content_length.ok_or(FrameError::MissingContentLength)?;
    if length > MAX_BODY_BYTES {
        return Err(FrameError::BodyTooLarge(length, MAX_BODY_BYTES));
    }

    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let parsed: T = serde_json::from_slice(&body)?;
    Ok(parsed)
}

/// Serialise `value` and emit it as one framed message. `writer` is
/// flushed before returning so callers don't have to chase the
/// underlying buffer.
pub fn write_frame<W, T>(writer: &mut W, value: &T) -> Result<(), FrameError>
where
    W: Write,
    T: Serialize,
{
    let body = serde_json::to_vec(value)?;
    write!(writer, "Content-Length: {}\r\n", body.len())?;
    write!(writer, "Content-Type: application/json\r\n")?;
    writer.write_all(b"\r\n")?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::io::Cursor;

    fn round_trip(value: Value) -> Value {
        let mut buf = Vec::new();
        write_frame(&mut buf, &value).unwrap();
        let mut reader = Cursor::new(buf);
        read_frame::<_, Value>(&mut reader).unwrap()
    }

    #[test]
    fn write_then_read_round_trips_arbitrary_json() {
        let value = json!({
            "method": "initialize",
            "params": { "protocolVersion": "0.1.0" },
            "id": 7,
            "binary_safe": "embedded\nnewline\nworks",
        });
        let restored = round_trip(value.clone());
        assert_eq!(restored, value);
    }

    #[test]
    fn read_frame_returns_eof_on_clean_close() {
        let mut empty: Cursor<Vec<u8>> = Cursor::new(Vec::new());
        let err = read_frame::<_, Value>(&mut empty).unwrap_err();
        assert!(matches!(err, FrameError::Eof), "expected Eof, got {err:?}");
    }

    #[test]
    fn read_frame_rejects_oversized_body() {
        // Craft a header claiming a body larger than the cap. The
        // codec should refuse before allocating the buffer — that's
        // the whole point of the cap.
        let too_big = MAX_BODY_BYTES + 1;
        let bad_frame = format!("Content-Length: {too_big}\r\n\r\n");
        let mut reader = Cursor::new(bad_frame.into_bytes());
        let err = read_frame::<_, Value>(&mut reader).unwrap_err();
        match err {
            FrameError::BodyTooLarge(claimed, cap) => {
                assert_eq!(claimed, too_big);
                assert_eq!(cap, MAX_BODY_BYTES);
            }
            other => panic!("expected BodyTooLarge, got {other:?}"),
        }
    }

    #[test]
    fn read_frame_rejects_missing_content_length() {
        let bad_frame = b"Content-Type: application/json\r\n\r\n{}";
        let mut reader = Cursor::new(bad_frame.to_vec());
        let err = read_frame::<_, Value>(&mut reader).unwrap_err();
        assert!(
            matches!(err, FrameError::MissingContentLength),
            "expected MissingContentLength, got {err:?}"
        );
    }

    #[test]
    fn read_frame_rejects_malformed_header() {
        let bad_frame = b"not-a-header\r\n\r\n{}";
        let mut reader = Cursor::new(bad_frame.to_vec());
        let err = read_frame::<_, Value>(&mut reader).unwrap_err();
        assert!(
            matches!(err, FrameError::MalformedHeader(_)),
            "expected MalformedHeader, got {err:?}"
        );
    }

    #[test]
    fn read_frame_is_case_insensitive_on_content_length_header() {
        // Per HTTP/LSP, header names are case-insensitive. Reject
        // spec-compliant peers that send `content-length:` would be
        // unfriendly.
        let frame = b"content-length: 2\r\n\r\n{}";
        let mut reader = Cursor::new(frame.to_vec());
        let decoded: Value = read_frame(&mut reader).unwrap();
        assert!(decoded.is_object());
    }

    #[test]
    fn read_frame_handles_multiple_back_to_back_messages() {
        // Two messages in one buffer — common in real connections
        // where the client sends `initialize` + `ping` without
        // waiting for the first reply.
        let mut buf = Vec::new();
        write_frame(&mut buf, &json!({"first": true})).unwrap();
        write_frame(&mut buf, &json!({"second": true})).unwrap();
        let mut reader = Cursor::new(buf);
        let a: Value = read_frame(&mut reader).unwrap();
        let b: Value = read_frame(&mut reader).unwrap();
        assert_eq!(a["first"], true);
        assert_eq!(b["second"], true);
    }
}
