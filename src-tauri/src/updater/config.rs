use std::time::Duration;

use anyhow::Context;
use url::Url;

use crate::settings;

const UPDATER_ENDPOINTS_ENV: Option<&str> = option_env!("HELMOR_UPDATER_ENDPOINTS");
const UPDATER_PUBKEY_ENV: Option<&str> = option_env!("HELMOR_UPDATER_PUBKEY");

const AUTO_UPDATE_ENABLED_KEY: &str = "app.auto_update_enabled";
const AUTO_UPDATE_ON_LAUNCH_KEY: &str = "app.auto_update_check_on_launch";
const AUTO_UPDATE_ON_FOCUS_KEY: &str = "app.auto_update_check_on_focus";
const AUTO_UPDATE_INTERVAL_MINUTES_KEY: &str = "app.auto_update_interval_minutes";

const DEFAULT_AUTO_UPDATE_ENABLED: bool = true;
const DEFAULT_AUTO_UPDATE_ON_LAUNCH: bool = true;
const DEFAULT_AUTO_UPDATE_ON_FOCUS: bool = true;
const DEFAULT_AUTO_UPDATE_INTERVAL_MINUTES: u64 = 360;
const DEFAULT_FOCUS_TTL_MINUTES: u64 = 30;
const DEFAULT_FAILURE_BACKOFF_MINUTES: u64 = 15;

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
    pub failure_backoff: Duration,
}

impl UpdateBehavior {
    pub fn load() -> Self {
        let auto_update_enabled =
            load_bool_setting(AUTO_UPDATE_ENABLED_KEY, DEFAULT_AUTO_UPDATE_ENABLED);
        let check_on_launch =
            load_bool_setting(AUTO_UPDATE_ON_LAUNCH_KEY, DEFAULT_AUTO_UPDATE_ON_LAUNCH);
        let check_on_focus =
            load_bool_setting(AUTO_UPDATE_ON_FOCUS_KEY, DEFAULT_AUTO_UPDATE_ON_FOCUS);
        let interval_minutes = load_u64_setting(
            AUTO_UPDATE_INTERVAL_MINUTES_KEY,
            DEFAULT_AUTO_UPDATE_INTERVAL_MINUTES,
        )
        .max(1);

        Self {
            auto_update_enabled,
            check_on_launch,
            check_on_focus,
            interval: Duration::from_secs(interval_minutes.saturating_mul(60)),
            focus_ttl: Duration::from_secs(DEFAULT_FOCUS_TTL_MINUTES * 60),
            failure_backoff: Duration::from_secs(DEFAULT_FAILURE_BACKOFF_MINUTES * 60),
        }
    }
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

fn load_u64_setting(key: &str, default: u64) -> u64 {
    settings::load_setting_value(key)
        .ok()
        .flatten()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(default)
}
