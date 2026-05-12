use anyhow::{bail, Result};

pub const ORDER_STEP: i64 = 1024;

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
}
