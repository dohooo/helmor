//! Bearer-token authentication for the companion HTTP surface.
//!
//! A request authenticates if its bearer matches the in-memory dev token (the
//! env-gated loopback convenience) OR passes the injected verifier (in
//! production, the per-device PATs in the `paired_devices` table). The verifier
//! is injected so the HTTP layer stays database-agnostic and testable.

use axum::http::{header::AUTHORIZATION, HeaderMap};

use super::Verifier;

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|text| text.strip_prefix("Bearer "))
}

/// Authorize a request: bearer matches the dev token (constant-time) or passes
/// the injected verifier (paired-device PAT lookup in production).
pub fn authorize(headers: &HeaderMap, dev_token: &str, verifier: &Verifier) -> bool {
    match extract_bearer(headers) {
        Some(bearer) => authorize_token(bearer, dev_token, verifier),
        None => false,
    }
}

/// Core token check, independent of where the token came from. Used by the
/// bearer path above and by the `<img>`-asset path (which authenticates via a
/// cookie since `<img>` can't set an `Authorization` header).
pub fn authorize_token(token: &str, dev_token: &str, verifier: &Verifier) -> bool {
    if constant_time_eq(token.as_bytes(), dev_token.as_bytes()) {
        return true;
    }
    verifier(token)
}

/// True when the request's bearer matches `expected` (constant-time). Retained
/// for unit tests of the comparison itself.
#[cfg(test)]
pub fn check_bearer(headers: &HeaderMap, expected: &str) -> bool {
    extract_bearer(headers)
        .map(|provided| constant_time_eq(provided.as_bytes(), expected.as_bytes()))
        .unwrap_or(false)
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
