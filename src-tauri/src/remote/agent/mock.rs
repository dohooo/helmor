//! In-memory spawner used by tests. The script is a list of
//! `(input_substring, response_events)` pairs: when the bridge writes
//! a sidecar request line containing `input_substring`, the mock emits
//! the matching events. Events are emitted on a background thread so
//! the bridge's reader loop sees them through its real channel.
//!
//! Lives in this module (not `tests/common/`) so unit tests can use
//! it without an integration-test rig. The module is `pub` so tests
//! across `remote::*` (transport, reattach) can reuse the same
//! harness.

#![cfg(test)]

use std::io::{BufReader, Read, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use serde_json::Value;

use super::spawner::{AgentSpawner, SidecarPipe};

/// One scripted reply. `match_substring` is matched against the
/// raw request line; an empty string matches every request.
pub struct ScriptedReply {
    pub match_substring: String,
    pub events: Vec<Value>,
    /// When `true`, the mock closes its stdout after emitting
    /// the events (simulates a sidecar crash mid-stream).
    pub close_after: bool,
}

pub struct MockAgentSpawner {
    pub(super) script: Mutex<Vec<ScriptedReply>>,
    ready_line: String,
}

impl MockAgentSpawner {
    pub fn new() -> Self {
        Self {
            script: Mutex::new(Vec::new()),
            ready_line: r#"{"type":"ready"}"#.to_string(),
        }
    }

    /// Override the handshake line. Used to test the
    /// not-ready-handshake path.
    pub fn with_handshake(mut self, line: impl Into<String>) -> Self {
        self.ready_line = line.into();
        self
    }

    pub fn respond(self, match_substring: impl Into<String>, events: Vec<Value>) -> Self {
        self.script.lock().unwrap().push(ScriptedReply {
            match_substring: match_substring.into(),
            events,
            close_after: false,
        });
        self
    }
}

impl Default for MockAgentSpawner {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentSpawner for MockAgentSpawner {
    fn spawn(&self) -> Result<SidecarPipe> {
        // Two channels: requests flow desktop → mock; events flow
        // mock → desktop. The reader/writer halves wrap the
        // channels in `Read`/`Write` impls.
        let (req_tx, req_rx) = mpsc::channel::<Vec<u8>>();
        let (resp_tx, resp_rx) = mpsc::channel::<Vec<u8>>();

        // Emit the handshake line up front so the bridge's
        // handshake drain succeeds.
        resp_tx
            .send(format!("{}\n", self.ready_line).into_bytes())
            .map_err(|e| anyhow!("mock: failed to seed handshake: {e}"))?;

        let script: Vec<ScriptedReply> = std::mem::take(&mut *self.script.lock().unwrap());
        std::thread::spawn(move || {
            let mut request = String::new();
            let mut stdin = ChannelReader::new(req_rx);
            let stdout = resp_tx;
            loop {
                request.clear();
                let mut byte = [0u8; 1];
                let mut found_line = false;
                while !found_line {
                    match stdin.read(&mut byte) {
                        Ok(0) => return,
                        Ok(_) => {
                            request.push(byte[0] as char);
                            if byte[0] == b'\n' {
                                found_line = true;
                            }
                        }
                        Err(_) => return,
                    }
                }
                let line = request.trim();
                if line.is_empty() {
                    continue;
                }
                // Find the first matching script entry and emit
                // its events. If nothing matches the request, the
                // mock stays silent — the test should configure
                // every expected request explicitly.
                let reply = script
                    .iter()
                    .find(|r| r.match_substring.is_empty() || line.contains(&r.match_substring));
                if let Some(reply) = reply {
                    for event in &reply.events {
                        let bytes = format!("{}\n", event);
                        if stdout.send(bytes.into_bytes()).is_err() {
                            return;
                        }
                    }
                    if reply.close_after {
                        return;
                    }
                }
            }
        });

        Ok(SidecarPipe {
            stdin: Box::new(ChannelWriter::new(req_tx)),
            stdout: Box::new(BufReader::new(ChannelReader::new(resp_rx))),
            child: None,
            label: "mock-sidecar".into(),
        })
    }
}

struct ChannelReader {
    rx: Receiver<Vec<u8>>,
    leftover: Vec<u8>,
}

impl ChannelReader {
    fn new(rx: Receiver<Vec<u8>>) -> Self {
        Self {
            rx,
            leftover: Vec::new(),
        }
    }
}

impl Read for ChannelReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.leftover.is_empty() {
            match self.rx.recv() {
                Ok(bytes) => self.leftover = bytes,
                Err(_) => return Ok(0),
            }
        }
        let take = self.leftover.len().min(out.len());
        out[..take].copy_from_slice(&self.leftover[..take]);
        self.leftover.drain(..take);
        Ok(take)
    }
}

struct ChannelWriter {
    tx: Sender<Vec<u8>>,
}

impl ChannelWriter {
    fn new(tx: Sender<Vec<u8>>) -> Self {
        Self { tx }
    }
}

impl Write for ChannelWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.tx
            .send(buf.to_vec())
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::BrokenPipe, err.to_string()))?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
