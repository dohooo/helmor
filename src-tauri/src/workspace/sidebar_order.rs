use anyhow::{bail, Result};

pub const ORDER_BASE: i64 = 67_108_864; // 2^26; keeps packed values below JS max-safe integer.
pub const ORDER_STEP: i64 = 1024;

pub fn pack(status_order: i64, repo_order: i64) -> Result<i64> {
    validate_component(status_order, "status_order")?;
    validate_component(repo_order, "repo_order")?;
    Ok(status_order * ORDER_BASE + repo_order)
}

pub fn status_order(display_order: i64) -> i64 {
    normalized_display_order(display_order) / ORDER_BASE
}

pub fn repo_order(display_order: i64) -> i64 {
    normalized_display_order(display_order) % ORDER_BASE
}

pub fn replace_status_order(display_order: i64, next_status_order: i64) -> Result<i64> {
    pack(next_status_order, repo_order(display_order))
}

pub fn replace_repo_order(display_order: i64, next_repo_order: i64) -> Result<i64> {
    pack(status_order(display_order), next_repo_order)
}

pub fn order_for_index(index: usize) -> Result<i64> {
    let order = ((index as i64) + 1) * ORDER_STEP;
    validate_component(order, "order")?;
    Ok(order)
}

pub fn status_order_expr(column: &str) -> String {
    format!("(COALESCE({column}, 0) / {ORDER_BASE})")
}

pub fn repo_order_expr(column: &str) -> String {
    format!("(COALESCE({column}, 0) % {ORDER_BASE})")
}

fn validate_component(value: i64, label: &str) -> Result<()> {
    if !(0..ORDER_BASE).contains(&value) {
        bail!("{label} {value} is outside sidebar order range 0..{ORDER_BASE}");
    }
    Ok(())
}

fn normalized_display_order(display_order: i64) -> i64 {
    display_order.max(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_round_trips_both_order_components() {
        let packed = pack(2048, 4096).unwrap();

        assert_eq!(status_order(packed), 2048);
        assert_eq!(repo_order(packed), 4096);
    }

    #[test]
    fn replace_updates_only_the_requested_component() {
        let packed = pack(2048, 4096).unwrap();

        let status_replaced = replace_status_order(packed, 8192).unwrap();
        assert_eq!(status_order(status_replaced), 8192);
        assert_eq!(repo_order(status_replaced), 4096);

        let repo_replaced = replace_repo_order(packed, 16_384).unwrap();
        assert_eq!(status_order(repo_replaced), 2048);
        assert_eq!(repo_order(repo_replaced), 16_384);
    }

    #[test]
    fn rejects_values_outside_the_component_range() {
        assert!(pack(ORDER_BASE, 0).is_err());
        assert!(pack(0, ORDER_BASE).is_err());
        assert!(pack(-1, 0).is_err());
    }

    #[test]
    fn packed_max_stays_below_js_safe_integer_limit() {
        let packed = pack(ORDER_BASE - 1, ORDER_BASE - 1).unwrap();

        assert!(packed < 9_007_199_254_740_991);
    }
}
