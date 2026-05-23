//! Tiny text helpers shared by chat / error-summary code paths.

/// Drop a wedge from the middle of `s` until it fits inside `max_chars`,
/// preserving the head (40 %) and tail (60 %) and inserting a
/// `[…truncated…]` marker in between. Returns the input unchanged when
/// it already fits.
pub fn truncate_middle(s: &str, max_chars: usize) -> String {
    let total = s.chars().count();
    if total <= max_chars {
        return s.to_string();
    }
    const MARKER: &str = " […truncated…] ";
    let marker_chars = MARKER.chars().count();
    if max_chars <= marker_chars + 20 {
        // Budget too small for head + marker + tail — keep the tail
        // (most recent text is the most useful).
        return s.chars().skip(total - max_chars).collect();
    }
    let usable = max_chars - marker_chars;
    let head_chars = usable * 4 / 10;
    let tail_chars = usable - head_chars;
    let head: String = s.chars().take(head_chars).collect();
    let tail: String = s.chars().skip(total - tail_chars).collect();
    format!("{head}{MARKER}{tail}")
}

/// Truncate `s` to `max` chars, appending `…` when clipped. Used to
/// keep llama-server error bodies log-friendly.
pub(super) fn truncate_for_log(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_middle_keeps_head_and_tail() {
        let s: String = ('A'..='Z').chain('a'..='z').chain('0'..='9').collect();
        assert!(s.chars().count() > 40);
        let out = truncate_middle(&s, 40);
        assert!(out.starts_with("ABCDE"), "kept head, got {out:?}");
        assert!(out.ends_with("56789"), "kept tail, got {out:?}");
        assert!(out.contains("truncated"), "marker present, got {out:?}");
        assert!(out.chars().count() <= 40);
    }

    #[test]
    fn truncate_middle_returns_input_when_already_fits() {
        assert_eq!(truncate_middle("short", 100), "short");
    }

    #[test]
    fn truncate_middle_falls_back_to_tail_when_budget_is_tiny() {
        let s = "0123456789ABCDEF";
        let out = truncate_middle(s, 8);
        assert_eq!(out.chars().count(), 8);
        assert!(out.ends_with("89ABCDEF"));
    }

    #[test]
    fn truncate_for_log_appends_ellipsis_when_over_limit() {
        let long = "x".repeat(1000);
        let out = truncate_for_log(&long, 16);
        assert_eq!(out.chars().count(), 17); // 16 chars + ellipsis
        assert!(out.ends_with('…'));
    }
}
