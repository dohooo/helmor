//! Watchdog process that sits between Helmor and the Executor daemon.
//!
//! ## Why this exists
//!
//! Helmor's cooperative shutdown path (`request_quit` → `ManagedExecutor::
//! shutdown` → SIGTERM child process group → 5 s grace → SIGKILL) is
//! correct, but it only runs when Helmor actually gets to execute its
//! cleanup hooks. In practice the dev workflow regularly bypasses that
//! path:
//!
//! - Terminal `Ctrl+C` on `bun run dev` → SIGINT to bun → Tauri may exit
//!   without firing `RunEvent::Exit`.
//! - `bun run dev` window closed → SIGHUP, same problem.
//! - Vite HMR force-reloads the Rust process.
//! - Activity Monitor "Force Quit" → SIGKILL — no Rust destructors run at
//!   all.
//!
//! The result is exactly what we hit in production: dozens of orphaned
//! `bunx executor@…` processes accumulate, each holding the shared
//! SQLite lock, until a fresh start fails with "Failed to prepare local
//! SQLite data."
//!
//! This binary fixes that by inserting itself between Helmor and the
//! actual `bunx executor` invocation. Process tree becomes:
//!
//! ```text
//! helmor
//!  └─ helmor-executor-watchdog --parent-pid=<helmor> -- bunx executor …
//!       └─ bunx executor …   (in its own process group)
//!            └─ executor (native binary)
//! ```
//!
//! The watchdog blocks on a single `kevent()` call that wakes on **any**
//! of:
//!
//! 1. `EVFILT_PROC + NOTE_EXIT` for the parent (Helmor) pid — fires
//!    even after Helmor is reparented to launchd via SIGKILL.
//! 2. `EVFILT_PROC + NOTE_EXIT` for the child (bunx) pid — normal exit.
//! 3. `EVFILT_SIGNAL` for SIGTERM/SIGINT/SIGHUP — our own signals from
//!    the cooperative shutdown path or terminal control.
//!
//! Signals are also `SIG_IGN`-ed so the default terminate action doesn't
//! race with kqueue delivery. When any wakeup fires the watchdog drives
//! the same SIGTERM-grace-SIGKILL cycle on the child's process group
//! (so both `bunx`'s `node` wrapper AND its spawned native binary die),
//! reaps the child, and exits.
//!
//! ## Why not in-process from Helmor
//!
//! In-process logic can't survive Helmor's own SIGKILL. The whole point
//! is to have **a separate OS process** whose only job is to watch its
//! progenitor and clean up the daemon when it's gone. macOS reparents
//! orphans to launchd, but the watchdog's kqueue subscription on the
//! original parent PID still fires — `NOTE_EXIT` is a notification
//! about the process, not about parentage.
//!
//! ## Platform support
//!
//! Today: macOS only (`kqueue` / `EVFILT_PROC` / `EVFILT_SIGNAL`).
//! Helmor itself is macOS-primary. The Linux equivalent (`prctl(PR_SET_
//! PDEATHSIG, …)` plus a `signalfd`/`epoll` loop) and the Windows
//! equivalent (`OpenProcess` + `WaitForSingleObject` on a parent handle
//! shared via `DuplicateHandle`) can be slotted in behind the existing
//! arg shape when those platforms ship.

use std::os::unix::process::CommandExt;
use std::process::{exit, Command};
use std::time::{Duration, Instant};

/// Maximum number of `kevent` slots we register / drain in a single
/// call. 2 process watches + 3 signal watches = 5; pick a small power
/// of two to keep the stack arrays tidy.
const MAX_EVENTS: usize = 8;

/// How long the watchdog waits for the child to drain after sending
/// SIGTERM before escalating to SIGKILL. Deliberately set **below**
/// the parent-side `SIGTERM_GRACE` in `executor_studio::mod` (5 s)
/// so a stuck child can't trigger a race where Helmor escalates to
/// SIGKILL on the watchdog at the same moment the watchdog itself is
/// about to SIGKILL the child — if Helmor wins, the child gets
/// orphaned again. The 2 s headroom is the buffer.
///
/// If you bump Helmor's `SIGTERM_GRACE`, keep this strictly smaller.
const TERMINATE_GRACE: Duration = Duration::from_secs(3);

/// Polling cadence inside the post-SIGTERM wait loop. 50 ms is short
/// enough that a fast-shutdown executor (<200 ms is typical) doesn't
/// pay a noticeable extra latency, but long enough that we don't spin.
const REAP_POLL: Duration = Duration::from_millis(50);

fn main() {
    let (parent_pid, inner_cmd, inner_args) = match parse_args() {
        Ok(parsed) => parsed,
        Err(usage) => {
            eprintln!("{usage}");
            exit(2);
        }
    };

    // Stop the default terminate action for the signals we want to
    // route through kqueue instead. We deliberately do this *before*
    // spawning the child so that any SIGTERM arriving in the tiny
    // window between fork and `kevent()` registration becomes a
    // pending kqueue event rather than killing us mid-setup.
    install_signal_ignores();

    // Spawn the child in its own process group so a single
    // `kill(-pid, …)` reaches every descendant — `bunx`'s `node`
    // wrapper AND the native `executor` binary it execs into.
    let mut child = match Command::new(&inner_cmd)
        .args(&inner_args)
        .process_group(0)
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            eprintln!("watchdog: spawn `{inner_cmd}`: {err}");
            exit(1);
        }
    };
    let child_pid = child.id() as libc::pid_t;

    let kq = unsafe { libc::kqueue() };
    if kq < 0 {
        eprintln!("watchdog: kqueue: {}", std::io::Error::last_os_error());
        terminate_child(child_pid);
        let _ = child.wait();
        exit(1);
    }

    // Register all wakeup sources up front. EV_RECEIPT makes the kernel
    // report success/failure for each registration synchronously without
    // returning an actual event yet, so we can detect a parent pid that
    // is already gone (ESRCH) and treat that as "parent died".
    let changes = [
        proc_exit_event(parent_pid),
        proc_exit_event(child_pid),
        signal_event(libc::SIGTERM),
        signal_event(libc::SIGINT),
        signal_event(libc::SIGHUP),
    ];
    let mut receipts: [libc::kevent; 5] = unsafe { std::mem::zeroed() };
    let receipts_len = receipts.len() as libc::c_int;
    let registered = unsafe {
        libc::kevent(
            kq,
            changes.as_ptr(),
            changes.len() as libc::c_int,
            receipts.as_mut_ptr(),
            receipts_len,
            std::ptr::null(),
        )
    };
    if registered < 0 {
        eprintln!(
            "watchdog: kevent register: {}",
            std::io::Error::last_os_error()
        );
        terminate_child(child_pid);
        let _ = child.wait();
        exit(1);
    }
    // Inspect receipts: ESRCH on the parent watch means the parent
    // pid is already gone (race: Helmor died before we registered).
    // Treat that as a parent-death wakeup and exit through the same
    // cleanup path.
    for receipt in &receipts[..(registered as usize).min(receipts.len())] {
        let is_error_receipt = (receipt.flags & libc::EV_ERROR) != 0;
        if !is_error_receipt || receipt.data == 0 {
            continue;
        }
        let pid_target = receipt.ident as libc::pid_t;
        // The signal IDs we register are SIGTERM/SIGINT/SIGHUP — all
        // small (<=64); any ESRCH on those would actually be a bug in
        // the registration code, not a real "process gone" signal. We
        // narrow to "process-exit watch errored with ESRCH" before
        // treating the error as parent-already-gone.
        if pid_target != parent_pid {
            continue;
        }
        if receipt.data as libc::c_int != libc::ESRCH {
            continue;
        }
        terminate_child(child_pid);
        let _ = child.wait();
        exit(0);
    }

    // Block until any registered source fires. There's no useful
    // bounded timeout here — every wakeup we care about is delivered
    // via kqueue, so the only way out of this call is "something
    // important happened".
    let mut events: [libc::kevent; MAX_EVENTS] = unsafe { std::mem::zeroed() };
    let n = unsafe {
        libc::kevent(
            kq,
            std::ptr::null(),
            0,
            events.as_mut_ptr(),
            events.len() as libc::c_int,
            std::ptr::null(),
        )
    };
    if n < 0 {
        eprintln!("watchdog: kevent wait: {}", std::io::Error::last_os_error());
        terminate_child(child_pid);
        let _ = child.wait();
        exit(1);
    }

    // Distinguish "child exited on its own" from "something else
    // happened" (parent died OR we got a signal). Child-exit lets us
    // propagate the executor's exit code; everything else drives the
    // SIGTERM-grace-SIGKILL cycle.
    let mut child_exited = false;
    for ev in &events[..n as usize] {
        if ev.filter == libc::EVFILT_PROC && ev.ident as libc::pid_t == child_pid {
            child_exited = true;
            break;
        }
    }

    if child_exited {
        let code = child
            .wait()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(0);
        exit(code);
    }

    terminate_child(child_pid);
    let _ = child.wait();
    exit(0);
}

/// Parse positional args. Shape: `<parent_pid> -- <command> [args...]`.
///
/// Returns the parent pid, the inner command, and the remaining args.
/// On invalid input returns a usage string so `main` can print + bail
/// with exit code 2.
fn parse_args() -> Result<(libc::pid_t, String, Vec<String>), String> {
    let argv: Vec<String> = std::env::args().collect();
    let prog = argv
        .first()
        .map(String::as_str)
        .unwrap_or("helmor-executor-watchdog");
    let usage = || {
        format!(
            "Usage: {prog} <parent_pid> -- <command> [args...]\n\
             \n\
             Spawns <command> as a child in its own process group and exits\n\
             when either <parent_pid> exits, the child exits, or this process\n\
             receives SIGTERM/SIGINT/SIGHUP. The child's process group is\n\
             SIGTERM'd (with a 5s grace) then SIGKILL'd before exit."
        )
    };

    if argv.len() < 4 {
        return Err(usage());
    }
    let parent_pid = argv[1]
        .parse::<libc::pid_t>()
        .ok()
        .filter(|p| *p > 0)
        .ok_or_else(usage)?;
    let separator_pos = argv.iter().position(|s| s == "--").ok_or_else(usage)?;
    if separator_pos != 2 {
        // Anything between <parent_pid> and `--` is a typo; reject so
        // future flag additions can land here without silent fallthrough.
        return Err(usage());
    }
    if separator_pos + 1 >= argv.len() {
        return Err(usage());
    }
    let inner_cmd = argv[separator_pos + 1].clone();
    let inner_args = argv[separator_pos + 2..].to_vec();
    Ok((parent_pid, inner_cmd, inner_args))
}

fn install_signal_ignores() {
    for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // SAFETY: `libc::signal` is async-signal-safe and SIG_IGN is a
        // valid disposition for every signal we touch. We don't read
        // the previous handler — the watchdog is the entry point so
        // nobody else has installed one.
        unsafe {
            libc::signal(sig, libc::SIG_IGN);
        }
    }
}

fn proc_exit_event(pid: libc::pid_t) -> libc::kevent {
    libc::kevent {
        ident: pid as libc::uintptr_t,
        filter: libc::EVFILT_PROC,
        // EV_ONESHOT auto-removes after firing — we never re-arm; the
        // first NOTE_EXIT for either pid is terminal. EV_RECEIPT makes
        // failed registrations show up in the receipts array instead
        // of returning -1 with only the first failure visible.
        flags: libc::EV_ADD | libc::EV_ONESHOT | libc::EV_RECEIPT,
        fflags: libc::NOTE_EXIT,
        data: 0,
        udata: std::ptr::null_mut(),
    }
}

fn signal_event(sig: libc::c_int) -> libc::kevent {
    libc::kevent {
        ident: sig as libc::uintptr_t,
        filter: libc::EVFILT_SIGNAL,
        flags: libc::EV_ADD | libc::EV_RECEIPT,
        fflags: 0,
        data: 0,
        udata: std::ptr::null_mut(),
    }
}

/// SIGTERM the child's process group, wait up to [`TERMINATE_GRACE`]
/// for it to exit, then SIGKILL. Returns once the child has been
/// reaped (or we've issued the SIGKILL and given the kernel a brief
/// chance to deliver it).
fn terminate_child(child_pid: libc::pid_t) {
    // Negative pid targets the entire process group, hitting both
    // `bunx`'s wrapper and the native executor binary in one syscall.
    unsafe {
        libc::kill(-child_pid, libc::SIGTERM);
    }
    let deadline = Instant::now() + TERMINATE_GRACE;
    while Instant::now() < deadline {
        let mut status: libc::c_int = 0;
        // SAFETY: waitpid(WNOHANG) returns immediately with 0 if the
        // child is still running, the pid on a successful reap, or -1
        // on error (which we treat as "already gone or unreachable —
        // give up the wait early").
        let reaped = unsafe { libc::waitpid(child_pid, &mut status, libc::WNOHANG) };
        if reaped != 0 {
            return;
        }
        std::thread::sleep(REAP_POLL);
    }
    unsafe {
        libc::kill(-child_pid, libc::SIGKILL);
    }
    // Final blocking reap so we don't leave a zombie behind for whoever
    // ends up adopting us (launchd, in the orphan case).
    let mut status: libc::c_int = 0;
    unsafe {
        libc::waitpid(child_pid, &mut status, 0);
    }
}
