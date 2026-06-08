//! PTY (pseudo-terminal) session seam for interactive script / terminal runs.
//!
//! The macOS/Unix implementation is the reference behavior: a `openpty` master
//! / slave pair, the child made a session + controlling-terminal leader
//! (`setsid` + `TIOCSCTTY`), a non-blocking master read via `poll(2)`, and
//! `TIOCSWINSZ` resizes. Windows support (ConPTY) fills the stubbed arms here
//! WITHOUT touching the shared run/terminal orchestration in
//! `workspace::scripts`.

use std::fs::File;
use std::process::{Child, Command};

use anyhow::Result;

/// Default PTY window size used when opening a new session. The frontend
/// issues a `resize` with the real terminal dimensions immediately after.
const DEFAULT_ROWS: u16 = 30;
const DEFAULT_COLS: u16 = 120;

/// A spawned child attached to a freshly-allocated PTY.
///
/// `writer` and `reader` are independent handles onto the same PTY master:
/// `writer` is used for user input (typing, paste, Ctrl+C) and resizes,
/// `reader` is drained by the single reader thread that merges stdout+stderr.
pub struct PtySession {
    pub child: Child,
    /// OS process id of the spawned child.
    pub pid: u32,
    /// Process-group id of the child (it is made a group leader).
    pub pgid: crate::platform::process::Pid,
    /// Write side of the PTY master.
    pub writer: File,
    /// Read side of the PTY master (merged stdout + stderr).
    pub reader: File,
}

/// Result of polling the PTY master for readability.
pub enum PollResult {
    /// The poll timed out with nothing ready.
    TimedOut,
    /// The poll was interrupted (`EINTR`); the caller should retry.
    Interrupted,
    /// The master is readable (and/or the slave hung up).
    Ready {
        /// The slave end closed (child exited); drain remaining bytes, then stop.
        hung_up: bool,
    },
}

/// Spawn `cmd` attached to a new PTY. The caller is responsible for the rest
/// of the orchestration (registering the handle, the reader thread, feeding
/// the initial command, and reaping via `child.wait()`).
pub fn spawn(cmd: Command) -> Result<PtySession> {
    #[cfg(unix)]
    {
        spawn_unix(cmd)
    }

    #[cfg(not(unix))]
    {
        // Windows adapter: allocate a ConPTY and attach `cmd` to it. Until
        // then, fail loudly rather than silently degrade — the macOS/Unix
        // path above is unaffected.
        let _ = cmd;
        anyhow::bail!("PTY sessions are not yet implemented on this platform")
    }
}

/// Resize the PTY behind `master` to `cols` x `rows`. The kernel delivers
/// `SIGWINCH` to the foreground process group so TUIs re-layout.
pub fn resize(master: &File, cols: u16, rows: u16) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let ret = unsafe {
            libc::ioctl(
                master.as_raw_fd(),
                libc::TIOCSWINSZ as libc::c_ulong,
                &ws as *const libc::winsize,
            )
        };
        if ret != 0 {
            anyhow::bail!("TIOCSWINSZ failed: {}", std::io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(not(unix))]
    {
        let _ = (master, cols, rows);
        anyhow::bail!("PTY resize is not yet implemented on this platform")
    }
}

/// Wait up to `timeout_ms` for the PTY `master` to become readable.
pub fn poll_readable(master: &File, timeout_ms: i32) -> std::io::Result<PollResult> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let mut pfd = libc::pollfd {
            fd: master.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let ret = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        if ret < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
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

    #[cfg(not(unix))]
    {
        let _ = (master, timeout_ms);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "PTY poll is not yet implemented on this platform",
        ))
    }
}

/// True when a read error is the benign end-of-session disconnect (`EIO` on
/// Unix when the child exits and the slave closes) rather than a real error
/// worth logging.
pub fn is_session_disconnect(err: &std::io::Error) -> bool {
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

#[cfg(unix)]
fn spawn_unix(mut cmd: Command) -> Result<PtySession> {
    use std::os::fd::FromRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let (master_fd, slave_fd) = open_pty()?;
    set_nonblocking(master_fd)?;

    // Dup master for the write side. Kept alive by the caller (in the process
    // handle) for the lifetime of the child so input / resize can reach the
    // PTY. `O_NONBLOCK` is shared with the read side via the dup.
    let writer_fd = unsafe { libc::dup(master_fd) };
    if writer_fd < 0 {
        let err = std::io::Error::last_os_error();
        unsafe {
            libc::close(master_fd);
            libc::close(slave_fd);
        }
        anyhow::bail!("dup(master_fd) failed: {err}");
    }
    let writer = unsafe { File::from_raw_fd(writer_fd) };

    // Dup slave for the pre_exec closure (`Stdio::from_raw_fd` takes ownership
    // of the fds attached below).
    let slave_for_session = unsafe { libc::dup(slave_fd) };

    // Set up the child's session and controlling terminal before exec.
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(slave_for_session, libc::TIOCSCTTY as libc::c_ulong, 0) == -1 {
                return Err(std::io::Error::last_os_error());
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

    // Drop cmd to close all parent copies of the slave fds. Without this the
    // master never sees EIO because the slave reference count stays > 0.
    drop(cmd);

    let pid = child.id();
    let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
    let reader = unsafe { File::from_raw_fd(master_fd) };

    Ok(PtySession {
        child,
        pid,
        pgid,
        writer,
        reader,
    })
}

/// Allocate a PTY pair via `openpty`. Returns (master_fd, slave_fd).
#[cfg(unix)]
fn open_pty() -> Result<(libc::c_int, libc::c_int)> {
    let mut master: libc::c_int = 0;
    let mut slave: libc::c_int = 0;
    let ws = libc::winsize {
        ws_row: DEFAULT_ROWS,
        ws_col: DEFAULT_COLS,
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
        anyhow::bail!("openpty failed: {}", std::io::Error::last_os_error());
    }
    Ok((master, slave))
}

#[cfg(unix)]
fn set_nonblocking(fd: libc::c_int) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 {
        anyhow::bail!("fcntl(F_GETFL) failed: {}", std::io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        anyhow::bail!("fcntl(F_SETFL) failed: {}", std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn spawn_runs_a_command_and_streams_pty_output() {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg("printf hello; exit 0");
        let mut session = spawn(cmd).expect("spawn pty");

        // Drain the merged PTY output until the child exits / slave closes.
        let mut out = Vec::new();
        let mut buf = [0u8; 256];
        loop {
            match poll_readable(&session.reader, 1000).expect("poll") {
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
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
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
        assert!(session.pid > 0);
    }
}
