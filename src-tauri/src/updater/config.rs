use std::time::Duration;

use anyhow::Context;
use url::Url;

use crate::settings;

const UPDATER_ENDPOINTS_ENV: Option<&str> = option_env!("HELMOR_UPDATER_ENDPOINTS");
const UPDATER_PUBKEY_ENV: Option<&str> = option_env!("HELMOR_UPDATER_PUBKEY");

const AUTO_UPDATE_ENABLED_KEY: &str = "app.auto_update_enabled";
const AUTO_UPDATE_ON_LAUNCH_KEY: &str = "app.auto_update_check_on_launch";
const AUTO_UPDATE_ON_FOCUS_KEY: &str = "app.auto_update_check_on_focus";

const DEFAULT_AUTO_UPDATE_ENABLED: bool = true;
const DEFAULT_AUTO_UPDATE_ON_LAUNCH: bool = true;
const DEFAULT_AUTO_UPDATE_ON_FOCUS: bool = true;
const DEFAULT_AUTO_UPDATE_INTERVAL_MINUTES: u64 = 30;
const DEFAULT_FOCUS_TTL_MINUTES: u64 = 10;

// Exponential backoff after consecutive failures: 1, 2, 4, 8, 16, 32, 60 (capped).
const FAILURE_BACKOFF_BASE_MINUTES: u64 = 1;
const FAILURE_BACKOFF_MAX_MINUTES: u64 = 60;
const FAILURE_BACKOFF_MAX_SHIFT: u32 = 6;

#[derive(Clone, Debug)]
pub struct UpdaterConfig {
    pub endpoints: Vec<Url>,
    pub pubkey: Option<String>,
}

impl UpdaterConfig {
    pub fn load() -> anyhow::Result<Self> {
        let endpoints = parse_endpoints(UPDATER_ENDPOINTS_ENV.unwrap_or_default())?;
        let pubkey = normalize_opt(UPDATER_PUBKEY_ENV);
        Ok(Self { endpoints, pubkey })
    }

    pub fn is_configured(&self) -> bool {
        !self.endpoints.is_empty() && self.pubkey.is_some()
    }
}

#[derive(Clone, Debug)]
pub struct UpdateBehavior {
    pub auto_update_enabled: bool,
    pub check_on_launch: bool,
    pub check_on_focus: bool,
    pub interval: Duration,
    pub focus_ttl: Duration,
}

impl UpdateBehavior {
    pub fn load() -> Self {
        let auto_update_enabled =
            load_bool_setting(AUTO_UPDATE_ENABLED_KEY, DEFAULT_AUTO_UPDATE_ENABLED);
        let check_on_launch =
            load_bool_setting(AUTO_UPDATE_ON_LAUNCH_KEY, DEFAULT_AUTO_UPDATE_ON_LAUNCH);
        let check_on_focus =
            load_bool_setting(AUTO_UPDATE_ON_FOCUS_KEY, DEFAULT_AUTO_UPDATE_ON_FOCUS);

        Self {
            auto_update_enabled,
            check_on_launch,
            check_on_focus,
            interval: Duration::from_secs(DEFAULT_AUTO_UPDATE_INTERVAL_MINUTES * 60),
            focus_ttl: Duration::from_secs(DEFAULT_FOCUS_TTL_MINUTES * 60),
        }
    }
}

/// Compute exponential backoff after `n` consecutive failures.
/// 1 → 1m, 2 → 2m, 3 → 4m, 4 → 8m, 5 → 16m, 6 → 32m, 7+ → 60m (capped).
pub fn failure_backoff(consecutive_failures: u32) -> Duration {
    if consecutive_failures == 0 {
        return Duration::ZERO;
    }
    let shift = (consecutive_failures - 1).min(FAILURE_BACKOFF_MAX_SHIFT);
    let minutes = FAILURE_BACKOFF_BASE_MINUTES
        .saturating_mul(1u64 << shift)
        .min(FAILURE_BACKOFF_MAX_MINUTES);
    Duration::from_secs(minutes * 60)
}

fn parse_endpoints(raw: &str) -> anyhow::Result<Vec<Url>> {
    raw.split([',', '\n'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Url::parse(value).with_context(|| format!("Invalid updater endpoint URL: {value}"))
        })
        .collect()
}

fn normalize_opt(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn load_bool_setting(key: &str, default: bool) -> bool {
    settings::load_setting_value(key)
        .ok()
        .flatten()
        .and_then(|value| match value.trim() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        })
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_backoff_progression() {
        assert_eq!(failure_backoff(0), Duration::ZERO);
        assert_eq!(failure_backoff(1), Duration::from_secs(60));
        assert_eq!(failure_backoff(2), Duration::from_secs(2 * 60));
        assert_eq!(failure_backoff(3), Duration::from_secs(4 * 60));
        assert_eq!(failure_backoff(4), Duration::from_secs(8 * 60));
        assert_eq!(failure_backoff(5), Duration::from_secs(16 * 60));
        assert_eq!(failure_backoff(6), Duration::from_secs(32 * 60));
        assert_eq!(failure_backoff(7), Duration::from_secs(60 * 60));
        assert_eq!(failure_backoff(99), Duration::from_secs(60 * 60));
    }
}
