//! Bearer-token authentication for the companion HTTP surface.
//!
//! Slice 0 validates against a single in-memory dev token. A later slice
//! replaces this with per-device PATs checked against the SHA-256
//! `paired_devices` table.

use axum::http::{header::AUTHORIZATION, HeaderMap};

/// True when the request carries `Authorization: Bearer <token>` matching the
/// expected token. Comparison is constant-time to avoid leaking the token via
/// timing.
pub fn check_bearer(headers: &HeaderMap, expected: &str) -> bool {
    let Some(value) = headers.get(AUTHORIZATION) else {
        return false;
    };
    let Ok(text) = value.to_str() else {
        return false;
    };
    let Some(provided) = text.strip_prefix("Bearer ") else {
        return false;
    };
    constant_time_eq(provided.as_bytes(), expected.as_bytes())
}

/// Length-checked constant-time byte comparison. The length check can leak the
/// token length, which is fixed and non-sensitive here.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers_with(auth: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, HeaderValue::from_str(auth).unwrap());
        h
    }

    #[test]
    fn accepts_matching_bearer() {
        let headers = headers_with("Bearer hlm_secret");
        assert!(check_bearer(&headers, "hlm_secret"));
    }

    #[test]
    fn rejects_wrong_token() {
        let headers = headers_with("Bearer hlm_wrong");
        assert!(!check_bearer(&headers, "hlm_secret"));
    }

    #[test]
    fn rejects_missing_prefix() {
        let headers = headers_with("hlm_secret");
        assert!(!check_bearer(&headers, "hlm_secret"));
    }

    #[test]
    fn rejects_absent_header() {
        assert!(!check_bearer(&HeaderMap::new(), "hlm_secret"));
    }

    #[test]
    fn constant_time_eq_basic() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }
}
