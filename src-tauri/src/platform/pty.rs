//! PTY (pseudo-terminal) session seam for interactive script / terminal runs.
//!
//! The seam exposes OS-agnostic trait objects — [`PtyChild`], [`PtyReader`],
//! and [`PtyWriter`] — so a Windows ConPTY (or `portable_pty`) adapter can
//! supply its own handle types without the shared run/terminal orchestration
//! in `workspace::scripts` touching `std::fs::File`, `libc`, or `poll(2)`
//! directly.
//!
//! The macOS/Unix implementation is the reference behavior: an `openpty`
//! master/slave pair, the child made a session + controlling-terminal leader
//! (`setsid` + `TIOCSCTTY`), a non-blocking master read driven by `poll(2)`,
//! and `TIOCSWINSZ` resizes — all kept inside the Unix adapter below. A
//! non-blocking master (drained after each poll wake) is deliberate: it lets
//! `write_stdin` get `WouldBlock` instead of blocking the IPC thread, and lets
//! the reader honor its stop flag via the poll timeout instead of waiting on an
//! EOF that a backgrounded grandchild could withhold.

use std::io::{self, Read, Write};
use std::process::{Command, ExitStatus};

use anyhow::Result;

/// The spawned child, reduced to what the run orchestration needs: `id()` for
/// the registry / `Started` event and `wait()` to reap. Unix wraps
/// `std::process::Child`; a Windows adapter wraps its ConPTY child.
pub trait PtyChild: Send {
    fn id(&self) -> u32;
    fn wait(&mut self) -> io::Result<ExitStatus>;
}

/// Write side of the PTY master: user input (typing / paste / Ctrl+C) and
/// window resize. Unix wraps the non-blocking master dup; a Windows adapter
/// wraps the ConPTY input handle.
pub trait PtyWriter: Write + Send {
    /// Resize the terminal so the kernel delivers `SIGWINCH` to the foreground
    /// process group and TUIs re-layout.
    fn resize(&self, cols: u16, rows: u16) -> io::Result<()>;
}

/// Read side of the PTY master (merged stdout + stderr). The orchestration runs
/// one reader thread that waits via [`PtyReader::poll_readable`] (so it can
/// honor its stop flag on the poll timeout) and drains via [`Read`]. Unix uses
/// `poll(2)` on the master; a Windows adapter supplies an equivalent readiness
/// check on its ConPTY output handle.
pub trait PtyReader: Read + Send {
    fn poll_readable(&self, timeout_ms: i32) -> io::Result<PollResult>;
}

/// Outcome of waiting for the PTY master to become readable.
pub enum PollResult {
    /// Timed out with nothing ready — the caller re-checks its stop flag.
    /// Constructed by the Unix `poll(2)` arm only; the Windows ConPTY reader
    /// is blocking and always reports `Ready`.
    #[cfg_attr(not(unix), allow(dead_code))]
    TimedOut,
    /// Interrupted (`EINTR`) — the caller should retry. Unix-arm only.
    #[cfg_attr(not(unix), allow(dead_code))]
    Interrupted,
    /// Readable, and/or the slave hung up.
    Ready {
        /// The slave end closed (child exited); drain remaining bytes, then stop.
        hung_up: bool,
    },
}

/// A spawned child attached to a freshly-allocated PTY.
pub struct PtySession {
    pub child: Box<dyn PtyChild>,
    /// Process-group id of the child (it is made a group leader). The pid
    /// itself is available via `child.id()`.
    pub pgid: crate::platform::process::Pid,
    /// Write side of the PTY master.
    pub writer: Box<dyn PtyWriter>,
    /// Read side of the PTY master (merged stdout + stderr).
    pub reader: Box<dyn PtyReader>,
}

/// True when a read error is the benign end-of-session disconnect (`EIO` on
/// Unix when the child exits and the slave closes) rather than a real error
/// worth logging.
pub fn is_session_disconnect(err: &io::Error) -> bool {
    #[cfg(unix)]
    {
        err.raw_os_error() == Some(libc::EIO)
    }

    #[cfg(not(unix))]
    {
        let _ = err;
        false
    }
}

/// Spawn `cmd` attached to a new PTY at an optional initial `(cols, rows)`. The
/// caller owns the rest of the orchestration (registering the handle, the
/// reader thread, feeding the initial command, and reaping via `child.wait()`).
///
/// An inline TUI paints its first frame against the size at spawn time —
/// defaults leave ghost rows behind once the real fit arrives, so callers that
/// know the renderer's size must pass it.
pub fn spawn_with_size(cmd: Command, size: Option<(u16, u16)>) -> Result<PtySession> {
    #[cfg(unix)]
    {
        spawn_unix(cmd, size)
    }

    #[cfg(windows)]
    {
        spawn_windows(cmd, size)
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (cmd, size);
        anyhow::bail!("PTY sessions are not yet implemented on this platform")
    }
}

// Windows ConPTY adapter, backed by `portable_pty`. ConPTY children can't be
// std `Child`s and their pipes aren't poll(2)-able fds, so each handle gets a
// trait wrapper. The reader is blocking: `poll_readable` reports ready and the
// drain loop relies on a 0-byte read (the pipe closing when the child exits)
// to stop, which is what the orchestration already treats as `hung_up`.
#[cfg(windows)]
fn spawn_windows(cmd: Command, size: Option<(u16, u16)>) -> Result<PtySession> {
    use std::sync::{Arc, Mutex};

    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    let (cols, rows) = size.unwrap_or((120, 30));
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| anyhow::anyhow!("ConPTY openpty failed: {e}"))?;

    let mut builder = CommandBuilder::new(cmd.get_program());
    for arg in cmd.get_args() {
        builder.arg(arg);
    }
    if let Some(dir) = cmd.get_current_dir() {
        builder.cwd(dir);
    }
    for (key, value) in cmd.get_envs() {
        match value {
            Some(value) => builder.env(key, value),
            None => builder.env_remove(key),
        }
    }

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| anyhow::anyhow!("ConPTY spawn failed: {e}"))?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| anyhow::anyhow!("ConPTY reader clone failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| anyhow::anyhow!("ConPTY writer failed: {e}"))?;

    // No process groups on Windows; the kill path keys off the pid.
    let pid = child.process_id().unwrap_or(0);

    Ok(PtySession {
        child: Box::new(WindowsPtyChild(child)),
        pgid: pid,
        writer: Box::new(WindowsPtyWriter {
            writer,
            master: Arc::new(Mutex::new(pair.master)),
        }),
        reader: Box::new(WindowsPtyReader(reader)),
    })
}

#[cfg(windows)]
struct WindowsPtyChild(Box<dyn portable_pty::Child + Send + Sync>);

#[cfg(windows)]
impl PtyChild for WindowsPtyChild {
    fn id(&self) -> u32 {
        self.0.process_id().unwrap_or(0)
    }
    fn wait(&mut self) -> io::Result<ExitStatus> {
        use std::os::windows::process::ExitStatusExt;
        let status = self.0.wait()?;
        Ok(ExitStatus::from_raw(status.exit_code()))
    }
}

#[cfg(windows)]
struct WindowsPtyWriter {
    writer: Box<dyn Write + Send>,
    master: std::sync::Arc<std::sync::Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
}

#[cfg(windows)]
impl Write for WindowsPtyWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.writer.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

#[cfg(windows)]
impl PtyWriter for WindowsPtyWriter {
    fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let master = self
            .master
            .lock()
            .map_err(|_| io::Error::other("ConPTY master lock poisoned"))?;
        master
            .resize(portable_pty::PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| io::Error::other(e.to_string()))
    }
}

#[cfg(windows)]
struct WindowsPtyReader(Box<dyn Read + Send>);

#[cfg(windows)]
impl Read for WindowsPtyReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

#[cfg(windows)]
impl PtyReader for WindowsPtyReader {
    fn poll_readable(&self, _timeout_ms: i32) -> io::Result<PollResult> {
        Ok(PollResult::Ready { hung_up: false })
    }
}

#[cfg(unix)]
const DEFAULT_ROWS: u16 = 30;
#[cfg(unix)]
const DEFAULT_COLS: u16 = 120;

#[cfg(unix)]
impl PtyChild for std::process::Child {
    fn id(&self) -> u32 {
        std::process::Child::id(self)
    }
    fn wait(&mut self) -> io::Result<ExitStatus> {
        std::process::Child::wait(self)
    }
}

/// Unix write side: the non-blocking master dup.
#[cfg(unix)]
pub struct UnixPtyWriter(pub std::fs::File);

#[cfg(unix)]
impl Write for UnixPtyWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

#[cfg(unix)]
impl PtyWriter for UnixPtyWriter {
    fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let ret = unsafe {
            libc::ioctl(
                self.0.as_raw_fd(),
                libc::TIOCSWINSZ as libc::c_ulong,
                &ws as *const libc::winsize,
            )
        };
        if ret != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// Unix read side: the master fd, drained after a `poll(2)` wake.
#[cfg(unix)]
pub struct UnixPtyReader(pub std::fs::File);

#[cfg(unix)]
impl Read for UnixPtyReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

#[cfg(unix)]
impl PtyReader for UnixPtyReader {
    fn poll_readable(&self, timeout_ms: i32) -> io::Result<PollResult> {
        use std::os::fd::AsRawFd;
        let mut pfd = libc::pollfd {
            fd: self.0.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let ret = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        if ret < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                return Ok(PollResult::Interrupted);
            }
            return Err(err);
        }
        if ret == 0 {
            return Ok(PollResult::TimedOut);
        }
        let hung_up = pfd.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0;
        Ok(PollResult::Ready { hung_up })
    }
}

#[cfg(unix)]
fn spawn_unix(mut cmd: Command, size: Option<(u16, u16)>) -> Result<PtySession> {
    use std::fs::File;
    use std::os::fd::FromRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let (master_fd, slave_fd) = open_pty(size)?;
    set_nonblocking(master_fd)?;

    // Dup master for the write side. `O_NONBLOCK` is shared with the read side
    // via the dup, so `write_stdin` gets `WouldBlock` (not a blocked IPC
    // thread) when the PTY input buffer is full.
    let writer_fd = unsafe { libc::dup(master_fd) };
    if writer_fd < 0 {
        let err = io::Error::last_os_error();
        unsafe {
            libc::close(master_fd);
            libc::close(slave_fd);
        }
        anyhow::bail!("dup(master_fd) failed: {err}");
    }
    let writer = UnixPtyWriter(unsafe { File::from_raw_fd(writer_fd) });

    // Dup slave for the pre_exec closure (`Stdio::from_raw_fd` takes ownership
    // of the fds attached below).
    let slave_for_session = unsafe { libc::dup(slave_fd) };

    // Set up the child's session and controlling terminal before exec.
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            if libc::ioctl(slave_for_session, libc::TIOCSCTTY as libc::c_ulong, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            libc::close(slave_for_session);
            Ok(())
        });
    }

    // Attach PTY slave as stdin/stdout/stderr.
    let child = unsafe {
        cmd.stdin(Stdio::from_raw_fd(slave_fd))
            .stdout(Stdio::from_raw_fd(libc::dup(slave_fd)))
            .stderr(Stdio::from_raw_fd(libc::dup(slave_fd)))
            .spawn()?
    };

    // Drop cmd to close the parent's copies of the slave fds. Without this the
    // master never sees EIO because the slave reference count stays > 0.
    drop(cmd);

    let pid = child.id();
    let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
    let reader = UnixPtyReader(unsafe { File::from_raw_fd(master_fd) });

    Ok(PtySession {
        child: Box::new(child),
        pgid,
        writer: Box::new(writer),
        reader: Box::new(reader),
    })
}

/// Allocate a PTY pair via `openpty`. Returns (master_fd, slave_fd).
#[cfg(unix)]
fn open_pty(size: Option<(u16, u16)>) -> Result<(libc::c_int, libc::c_int)> {
    let (cols, rows) = size.unwrap_or((DEFAULT_COLS, DEFAULT_ROWS));
    let mut master: libc::c_int = 0;
    let mut slave: libc::c_int = 0;
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let ret = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &ws as *const libc::winsize as *mut libc::winsize,
        )
    };
    if ret != 0 {
        anyhow::bail!("openpty failed: {}", io::Error::last_os_error());
    }
    Ok((master, slave))
}

#[cfg(unix)]
fn set_nonblocking(fd: libc::c_int) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 {
        anyhow::bail!("fcntl(F_GETFL) failed: {}", io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        anyhow::bail!("fcntl(F_SETFL) failed: {}", io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn spawn_runs_a_command_and_streams_pty_output() {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg("printf hello; exit 0");
        let mut session = spawn_with_size(cmd, None).expect("spawn pty");

        // Drain the merged PTY output until the child exits / slave closes,
        // exactly like the orchestration's reader thread.
        let mut out = Vec::new();
        let mut buf = [0u8; 256];
        loop {
            match session.reader.poll_readable(1000).expect("poll") {
                PollResult::TimedOut => break,
                PollResult::Interrupted => continue,
                PollResult::Ready { hung_up } => {
                    let mut drained_eof = false;
                    loop {
                        match session.reader.read(&mut buf) {
                            Ok(0) => {
                                drained_eof = true;
                                break;
                            }
                            Ok(n) => out.extend_from_slice(&buf[..n]),
                            Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                            Err(_) => {
                                drained_eof = true;
                                break;
                            }
                        }
                    }
                    if hung_up || drained_eof {
                        break;
                    }
                }
            }
        }
        let _ = session.child.wait();

        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("hello"), "PTY output was {text:?}");
        assert!(session.child.id() > 0);
    }
}
