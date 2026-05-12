use anyhow::{bail, Result};

pub const ORDER_STEP: i64 = 1024;

/// Smallest gap between two neighbours that still lets us insert a midpoint
/// without rebalancing the group.
pub const MIN_GAP: i64 = 2;

pub fn order_for_index(index: usize) -> Result<i64> {
    let order = ((index as i64) + 1) * ORDER_STEP;
    validate_order(order, "order")?;
    Ok(order)
}

pub fn validate_order(value: i64, label: &str) -> Result<()> {
    if value < 0 {
        bail!("{label} {value} must be >= 0");
    }
    Ok(())
}

/// Pick a sparse order between `prev` and `next` (both exclusive).
/// `None` for either side means "no neighbour on that side".
/// Returns `None` when the gap is too tight — caller must rebalance.
pub fn compute_midpoint(prev: Option<i64>, next: Option<i64>) -> Option<i64> {
    match (prev, next) {
        (None, None) => Some(ORDER_STEP),
        (Some(p), None) => Some(p + ORDER_STEP),
        (None, Some(n)) => {
            if n >= MIN_GAP {
                Some(n / 2)
            } else {
                None
            }
        }
        (Some(p), Some(n)) => {
            if n - p >= MIN_GAP {
                Some(p + (n - p) / 2)
            } else {
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_for_index_uses_sparse_one_based_ordering() {
        assert_eq!(order_for_index(0).unwrap(), ORDER_STEP);
        assert_eq!(order_for_index(2).unwrap(), 3 * ORDER_STEP);
    }

    #[test]
    fn rejects_negative_orders() {
        assert!(validate_order(-1, "order").is_err());
    }

    #[test]
    fn compute_midpoint_empty_group_uses_step() {
        assert_eq!(compute_midpoint(None, None), Some(ORDER_STEP));
    }

    #[test]
    fn compute_midpoint_appends_after_last() {
        assert_eq!(compute_midpoint(Some(2 * ORDER_STEP), None), Some(3072));
    }

    #[test]
    fn compute_midpoint_prepends_before_first() {
        assert_eq!(compute_midpoint(None, Some(2 * ORDER_STEP)), Some(1024));
    }

    #[test]
    fn compute_midpoint_picks_halfway_between_neighbours() {
        assert_eq!(compute_midpoint(Some(1024), Some(2048)), Some(1536));
    }

    #[test]
    fn compute_midpoint_returns_none_when_gap_exhausted() {
        assert_eq!(compute_midpoint(Some(10), Some(11)), None);
        assert_eq!(compute_midpoint(None, Some(1)), None);
    }
}
