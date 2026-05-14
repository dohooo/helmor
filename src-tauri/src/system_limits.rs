//! Process resource-limit tuning for the desktop host.

const TARGET_NOFILE_SOFT_LIMIT: u64 = 4096;

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
