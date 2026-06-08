//! Process resource-limit tuning for the desktop host.

const TARGET_NOFILE_SOFT_LIMIT: u64 = 4096;

/// Raise the soft cap on simultaneously-open file descriptors toward
/// [`TARGET_NOFILE_SOFT_LIMIT`]. On Unix this lifts `RLIMIT_NOFILE`; on Windows
/// there is no per-process descriptor rlimit (kernel handles are bounded by
/// memory), but the C runtime caps `stdio`-level FDs at 512 by default, so we
/// raise that instead.
#[cfg(unix)]
pub fn raise_nofile_soft_limit() {
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    let read_ok = unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut current) == 0 };
    if !read_ok {
        return;
    }

    let next = desired_nofile_soft_limit(current.rlim_cur, current.rlim_max);
    if next <= current.rlim_cur {
        return;
    }

    let updated = libc::rlimit {
        rlim_cur: next,
        rlim_max: current.rlim_max,
    };
    let _ = unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &updated) };
}

#[cfg(windows)]
pub fn raise_nofile_soft_limit() {
    // The CRT `_setmaxstdio` ceiling is what bounds fopen/_open-style FDs on
    // Windows; lift it to our target. Win32 HANDLEs (sockets, files opened via
    // CreateFile) are not affected by this and need no tuning.
    extern "C" {
        fn _setmaxstdio(new_max: i32) -> i32;
    }
    let _ = unsafe { _setmaxstdio(TARGET_NOFILE_SOFT_LIMIT as i32) };
}

// Used by the Unix `raise_nofile_soft_limit` and by the cross-platform unit
// tests; the Windows lib path uses `_setmaxstdio` directly, so this is dead
// code there.
#[cfg_attr(not(unix), allow(dead_code))]
fn desired_nofile_soft_limit(current_soft: u64, hard: u64) -> u64 {
    current_soft.max(TARGET_NOFILE_SOFT_LIMIT.min(hard))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desired_nofile_soft_limit_raises_to_target_when_hard_limit_allows() {
        assert_eq!(desired_nofile_soft_limit(256, 10_000), 4096);
    }

    #[test]
    fn desired_nofile_soft_limit_caps_at_hard_limit() {
        assert_eq!(desired_nofile_soft_limit(256, 1024), 1024);
    }

    #[test]
    fn desired_nofile_soft_limit_never_lowers_current_soft_limit() {
        assert_eq!(desired_nofile_soft_limit(8192, 10_000), 8192);
    }
}
