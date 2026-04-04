use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration, Utc};
use keyring::Entry;
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration as StdDuration;
use tauri::{AppHandle, Emitter};

use super::settings;

const GITHUB_IDENTITY_META_KEY: &str = "github_identity_meta";
const KEYRING_SERVICE: &str = "build.helmor.app";
const KEYRING_ACCOUNT: &str = "github-identity";
const DEVICE_FLOW_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_GRANT_TYPE: &str = "refresh_token";
const DEFAULT_POLL_INTERVAL_SECONDS: u64 = 5;
pub const GITHUB_IDENTITY_CHANGED_EVENT: &str = "github-identity-changed";

#[derive(Clone, Default)]
pub struct GithubIdentityFlowRuntime {
    generation: Arc<AtomicU64>,
}

impl GithubIdentityFlowRuntime {
    fn start_new_flow(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn cancel_current_flow(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    fn is_current_flow(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubIdentitySession {
    pub provider: String,
    pub github_user_id: i64,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub primary_email: Option<String>,
    pub token_expires_at: Option<String>,
    pub refresh_token_expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum GithubIdentitySnapshot {
    Connected { session: GithubIdentitySession },
    Disconnected,
    Unconfigured { message: String },
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubIdentityDeviceFlowStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_at: String,
    pub interval_seconds: u64,
}

#[cfg(test)]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
enum GithubIdentityConnectPollResult {
    Pending {
        interval_seconds: u64,
    },
    Connected {
        session: GithubIdentitySession,
    },
    Error {
        code: String,
        message: String,
        retryable: bool,
    },
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone)]
enum DeviceFlowPollOutcome {
    Pending {
        interval_seconds: u64,
    },
    Connected {
        meta: GithubIdentityMeta,
        secret: StoredIdentitySecret,
    },
    Error {
        code: String,
        message: String,
        retryable: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GithubIdentityMeta {
    provider: String,
    github_user_id: i64,
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
    primary_email: Option<String>,
    token_expires_at: Option<String>,
    refresh_token_expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredIdentitySecret {
    access_token: String,
    refresh_token: Option<String>,
    access_token_expires_at: Option<String>,
    refresh_token_expires_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: i64,
    interval: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
struct OAuthTokenResponse {
    access_token: Option<String>,
    expires_in: Option<i64>,
    refresh_token: Option<String>,
    refresh_token_expires_in: Option<i64>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubUser {
    id: i64,
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubUserEmail {
    email: String,
    primary: bool,
    verified: Option<bool>,
}

#[derive(Debug, Clone)]
struct OAuthTokenSuccess {
    access_token: String,
    refresh_token: Option<String>,
    access_token_expires_at: Option<String>,
    refresh_token_expires_at: Option<String>,
}

trait SecretStore {
    fn load(&self) -> Result<Option<StoredIdentitySecret>>;
    fn save(&self, secret: &StoredIdentitySecret) -> Result<()>;
    fn delete(&self) -> Result<()>;
}

trait GithubHttpClient {
    fn start_device_flow(&self, client_id: &str) -> Result<DeviceCodeResponse>;
    fn exchange_device_code(
        &self,
        client_id: &str,
        device_code: &str,
    ) -> Result<OAuthTokenResponse>;
    fn refresh_user_token(&self, client_id: &str, refresh_token: &str)
        -> Result<OAuthTokenSuccess>;
    fn get_authenticated_user(&self, access_token: &str) -> Result<GithubUser>;
    fn get_primary_email(&self, access_token: &str) -> Result<Option<String>>;
}

pub fn get_github_identity_session() -> Result<GithubIdentitySnapshot> {
    let client = ReqwestGithubClient::new()?;
    let secret_store = KeyringSecretStore;
    match get_github_identity_session_with(github_client_id(), &client, &secret_store) {
        Ok(snapshot) => Ok(snapshot),
        Err(error) => Ok(GithubIdentitySnapshot::Error {
            message: format!("{error:#}"),
        }),
    }
}

pub fn start_github_identity_connect(
    app: AppHandle,
    runtime: GithubIdentityFlowRuntime,
) -> Result<GithubIdentityDeviceFlowStart> {
    let generation = runtime.start_new_flow();
    let client = ReqwestGithubClient::new()?;
    let flow = start_github_identity_connect_with(github_client_id(), &client)?;
    spawn_identity_poll_loop(app, runtime, generation, flow.clone());
    Ok(flow)
}

pub fn cancel_github_identity_connect(
    app: AppHandle,
    runtime: GithubIdentityFlowRuntime,
) -> Result<()> {
    runtime.cancel_current_flow();
    emit_github_identity_snapshot(&app, &GithubIdentitySnapshot::Disconnected)
}

pub fn disconnect_github_identity(
    app: AppHandle,
    runtime: GithubIdentityFlowRuntime,
) -> Result<()> {
    let secret_store = KeyringSecretStore;
    runtime.cancel_current_flow();
    clear_stored_identity(&secret_store)?;
    emit_github_identity_snapshot(&app, &GithubIdentitySnapshot::Disconnected)
}

fn get_github_identity_session_with(
    client_id: Option<&str>,
    client: &impl GithubHttpClient,
    secret_store: &impl SecretStore,
) -> Result<GithubIdentitySnapshot> {
    let Some(client_id) = client_id else {
        return Ok(GithubIdentitySnapshot::Unconfigured {
            message:
                "GitHub account connection is not configured. Rebuild Helmor with HELMOR_GITHUB_CLIENT_ID."
                    .to_string(),
        });
    };

    let stored = load_stored_identity(secret_store)?;
    let Some((mut meta, mut secret)) = stored else {
        return Ok(GithubIdentitySnapshot::Disconnected);
    };

    if !is_expired(secret.access_token_expires_at.as_deref()) {
        sync_meta_expiry_fields(&mut meta, &secret);
        return Ok(GithubIdentitySnapshot::Connected {
            session: meta.into_session(),
        });
    }

    if is_expired(secret.refresh_token_expires_at.as_deref()) || secret.refresh_token.is_none() {
        clear_stored_identity(secret_store)?;
        return Ok(GithubIdentitySnapshot::Disconnected);
    }

    let refreshed = match client.refresh_user_token(
        client_id,
        secret
            .refresh_token
            .as_deref()
            .context("Missing refresh token for GitHub identity refresh")?,
    ) {
        Ok(response) => response,
        Err(_) => {
            clear_stored_identity(secret_store)?;
            return Ok(GithubIdentitySnapshot::Disconnected);
        }
    };

    secret.access_token = refreshed.access_token;
    secret.refresh_token = refreshed.refresh_token.or(secret.refresh_token);
    secret.access_token_expires_at = refreshed.access_token_expires_at;
    secret.refresh_token_expires_at = refreshed.refresh_token_expires_at;

    sync_meta_expiry_fields(&mut meta, &secret);
    save_stored_identity(&meta, &secret, secret_store)?;

    Ok(GithubIdentitySnapshot::Connected {
        session: meta.into_session(),
    })
}

fn start_github_identity_connect_with(
    client_id: Option<&str>,
    client: &impl GithubHttpClient,
) -> Result<GithubIdentityDeviceFlowStart> {
    let client_id = require_client_id(client_id)?;
    let response = client.start_device_flow(client_id)?;

    Ok(GithubIdentityDeviceFlowStart {
        device_code: response.device_code,
        user_code: response.user_code,
        verification_uri: response.verification_uri,
        verification_uri_complete: response.verification_uri_complete,
        expires_at: expiry_from_now(response.expires_in),
        interval_seconds: response.interval.unwrap_or(DEFAULT_POLL_INTERVAL_SECONDS),
    })
}

fn spawn_identity_poll_loop(
    app: AppHandle,
    runtime: GithubIdentityFlowRuntime,
    generation: u64,
    flow: GithubIdentityDeviceFlowStart,
) {
    thread::spawn(move || {
        let client = match ReqwestGithubClient::new() {
            Ok(client) => client,
            Err(error) => {
                let _ = emit_github_identity_snapshot(
                    &app,
                    &GithubIdentitySnapshot::Error {
                        message: format!("{error:#}"),
                    },
                );
                return;
            }
        };
        let secret_store = KeyringSecretStore;
        let mut interval_seconds = flow.interval_seconds.max(1);

        loop {
            if !runtime.is_current_flow(generation) {
                return;
            }

            thread::sleep(StdDuration::from_secs(interval_seconds));

            if !runtime.is_current_flow(generation) {
                return;
            }

            let outcome = poll_github_identity_connect_outcome(
                github_client_id(),
                &client,
                &flow.device_code,
            );

            if !runtime.is_current_flow(generation) {
                return;
            }

            match outcome {
                Ok(DeviceFlowPollOutcome::Pending {
                    interval_seconds: next_interval,
                }) => {
                    interval_seconds = next_interval.max(1);
                }
                Ok(DeviceFlowPollOutcome::Connected { meta, secret }) => {
                    if !runtime.is_current_flow(generation) {
                        return;
                    }

                    if let Err(error) = save_stored_identity(&meta, &secret, &secret_store) {
                        if !runtime.is_current_flow(generation) {
                            return;
                        }

                        let _ = emit_github_identity_snapshot(
                            &app,
                            &GithubIdentitySnapshot::Error {
                                message: format!("{error:#}"),
                            },
                        );
                        return;
                    }

                    if !runtime.is_current_flow(generation) {
                        return;
                    }

                    let _ = emit_github_identity_snapshot(
                        &app,
                        &GithubIdentitySnapshot::Connected {
                            session: meta.into_session(),
                        },
                    );
                    return;
                }
                Ok(DeviceFlowPollOutcome::Error { message, .. }) => {
                    if !runtime.is_current_flow(generation) {
                        return;
                    }

                    let _ = emit_github_identity_snapshot(
                        &app,
                        &GithubIdentitySnapshot::Error { message },
                    );
                    return;
                }
                Err(error) => {
                    if !runtime.is_current_flow(generation) {
                        return;
                    }

                    let _ = emit_github_identity_snapshot(
                        &app,
                        &GithubIdentitySnapshot::Error {
                            message: format!("{error:#}"),
                        },
                    );
                    return;
                }
            }
        }
    });
}

fn emit_github_identity_snapshot(app: &AppHandle, snapshot: &GithubIdentitySnapshot) -> Result<()> {
    app.emit(GITHUB_IDENTITY_CHANGED_EVENT, snapshot)
        .context("Failed to emit github-identity-changed event")
}

#[cfg(test)]
fn poll_github_identity_connect_with(
    client_id: Option<&str>,
    client: &impl GithubHttpClient,
    secret_store: &impl SecretStore,
    device_code: &str,
) -> Result<GithubIdentityConnectPollResult> {
    match poll_github_identity_connect_outcome(client_id, client, device_code)? {
        DeviceFlowPollOutcome::Pending { interval_seconds } => {
            Ok(GithubIdentityConnectPollResult::Pending { interval_seconds })
        }
        DeviceFlowPollOutcome::Connected { meta, secret } => {
            let session = meta.clone().into_session();
            save_stored_identity(&meta, &secret, secret_store)?;

            Ok(GithubIdentityConnectPollResult::Connected { session })
        }
        DeviceFlowPollOutcome::Error {
            code,
            message,
            retryable,
        } => Ok(GithubIdentityConnectPollResult::Error {
            code,
            message,
            retryable,
        }),
    }
}

fn poll_github_identity_connect_outcome(
    client_id: Option<&str>,
    client: &impl GithubHttpClient,
    device_code: &str,
) -> Result<DeviceFlowPollOutcome> {
    let client_id = require_client_id(client_id)?;
    let token = client.exchange_device_code(client_id, device_code)?;

    if let Some(access_token) = token.access_token {
        let user = client.get_authenticated_user(&access_token)?;
        let primary_email = client.get_primary_email(&access_token).unwrap_or_default();
        let secret = StoredIdentitySecret {
            access_token,
            refresh_token: token.refresh_token,
            access_token_expires_at: token.expires_in.map(expiry_from_now),
            refresh_token_expires_at: token.refresh_token_expires_in.map(expiry_from_now),
        };
        let meta = GithubIdentityMeta {
            provider: "github-app-device-flow".to_string(),
            github_user_id: user.id,
            login: user.login,
            name: user.name,
            avatar_url: user.avatar_url,
            primary_email,
            token_expires_at: secret.access_token_expires_at.clone(),
            refresh_token_expires_at: secret.refresh_token_expires_at.clone(),
        };

        return Ok(DeviceFlowPollOutcome::Connected { meta, secret });
    }

    let code = token.error.unwrap_or_else(|| "unknown_error".to_string());
    let message = token
        .error_description
        .unwrap_or_else(|| default_oauth_error_message(&code).to_string());

    match code.as_str() {
        "authorization_pending" => Ok(DeviceFlowPollOutcome::Pending {
            interval_seconds: DEFAULT_POLL_INTERVAL_SECONDS,
        }),
        "slow_down" => Ok(DeviceFlowPollOutcome::Pending {
            interval_seconds: DEFAULT_POLL_INTERVAL_SECONDS + 5,
        }),
        "expired_token" | "access_denied" => Ok(DeviceFlowPollOutcome::Error {
            code,
            message,
            retryable: false,
        }),
        _ => Ok(DeviceFlowPollOutcome::Error {
            code,
            message,
            retryable: true,
        }),
    }
}

fn save_stored_identity(
    meta: &GithubIdentityMeta,
    secret: &StoredIdentitySecret,
    secret_store: &impl SecretStore,
) -> Result<()> {
    settings::upsert_setting_json(GITHUB_IDENTITY_META_KEY, meta)?;
    secret_store.save(secret)?;
    Ok(())
}

fn load_stored_identity(
    secret_store: &impl SecretStore,
) -> Result<Option<(GithubIdentityMeta, StoredIdentitySecret)>> {
    let meta = settings::load_setting_json::<GithubIdentityMeta>(GITHUB_IDENTITY_META_KEY)?;
    let secret = secret_store.load()?;

    match (meta, secret) {
        (None, None) => Ok(None),
        (Some(meta), Some(secret)) => Ok(Some((meta, secret))),
        _ => {
            clear_stored_identity(secret_store)?;
            Ok(None)
        }
    }
}

fn clear_stored_identity(secret_store: &impl SecretStore) -> Result<()> {
    settings::delete_setting_value(GITHUB_IDENTITY_META_KEY)?;
    secret_store.delete()?;
    Ok(())
}

fn sync_meta_expiry_fields(meta: &mut GithubIdentityMeta, secret: &StoredIdentitySecret) {
    meta.token_expires_at = secret.access_token_expires_at.clone();
    meta.refresh_token_expires_at = secret.refresh_token_expires_at.clone();
}

fn github_client_id() -> Option<&'static str> {
    option_env!("HELMOR_GITHUB_CLIENT_ID").filter(|value| !value.trim().is_empty())
}

fn require_client_id(client_id: Option<&str>) -> Result<&str> {
    client_id.ok_or_else(|| {
        anyhow!(
            "GitHub account connection is not configured. Rebuild Helmor with HELMOR_GITHUB_CLIENT_ID."
        )
    })
}

fn expiry_from_now(seconds: i64) -> String {
    (Utc::now() + Duration::seconds(seconds)).to_rfc3339()
}

fn is_expired(value: Option<&str>) -> bool {
    let Some(raw) = value else {
        return false;
    };

    DateTime::parse_from_rfc3339(raw)
        .map(|parsed| parsed.with_timezone(&Utc) <= Utc::now())
        .unwrap_or(true)
}

fn default_oauth_error_message(code: &str) -> &'static str {
    match code {
        "authorization_pending" => "Waiting for GitHub authorization.",
        "slow_down" => "GitHub asked Helmor to poll more slowly.",
        "expired_token" => "This login code expired. Start again.",
        "access_denied" => "GitHub login was cancelled or denied.",
        _ => "GitHub login failed.",
    }
}

struct KeyringSecretStore;

impl SecretStore for KeyringSecretStore {
    fn load(&self) -> Result<Option<StoredIdentitySecret>> {
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)?;
        match entry.get_password() {
            Ok(value) => {
                let parsed = serde_json::from_str::<StoredIdentitySecret>(&value)
                    .context("Failed to deserialize stored GitHub identity secret")?;
                Ok(Some(parsed))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error).context("Failed to load GitHub identity secret"),
        }
    }

    fn save(&self, secret: &StoredIdentitySecret) -> Result<()> {
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)?;
        let serialized =
            serde_json::to_string(secret).context("Failed to serialize GitHub identity secret")?;
        entry
            .set_password(&serialized)
            .context("Failed to save GitHub identity secret")
    }

    fn delete(&self) -> Result<()> {
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error).context("Failed to delete GitHub identity secret"),
        }
    }
}

struct ReqwestGithubClient {
    client: Client,
}

impl ReqwestGithubClient {
    fn new() -> Result<Self> {
        let client = Client::builder()
            .build()
            .context("Failed to build GitHub HTTP client")?;
        Ok(Self { client })
    }

    fn post_form<T: for<'de> Deserialize<'de>>(
        &self,
        url: &str,
        body: &[(&str, &str)],
    ) -> Result<T> {
        let response = self
            .client
            .post(url)
            .header(USER_AGENT, "Helmor")
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .form(body)
            .send()
            .with_context(|| format!("Failed to call GitHub endpoint {url}"))?;

        response
            .json::<T>()
            .with_context(|| format!("Failed to decode GitHub response from {url}"))
    }
}

impl GithubHttpClient for ReqwestGithubClient {
    fn start_device_flow(&self, client_id: &str) -> Result<DeviceCodeResponse> {
        self.post_form(
            "https://github.com/login/device/code",
            &[("client_id", client_id)],
        )
    }

    fn exchange_device_code(
        &self,
        client_id: &str,
        device_code: &str,
    ) -> Result<OAuthTokenResponse> {
        self.post_form(
            "https://github.com/login/oauth/access_token",
            &[
                ("client_id", client_id),
                ("device_code", device_code),
                ("grant_type", DEVICE_FLOW_GRANT_TYPE),
            ],
        )
    }

    fn refresh_user_token(
        &self,
        client_id: &str,
        refresh_token: &str,
    ) -> Result<OAuthTokenSuccess> {
        let response = self.post_form::<OAuthTokenResponse>(
            "https://github.com/login/oauth/access_token",
            &[
                ("client_id", client_id),
                ("grant_type", REFRESH_GRANT_TYPE),
                ("refresh_token", refresh_token),
            ],
        )?;

        if let Some(access_token) = response.access_token {
            return Ok(OAuthTokenSuccess {
                access_token,
                refresh_token: response.refresh_token,
                access_token_expires_at: response.expires_in.map(expiry_from_now),
                refresh_token_expires_at: response.refresh_token_expires_in.map(expiry_from_now),
            });
        }

        Err(anyhow!(
            "{}",
            response
                .error_description
                .unwrap_or_else(|| "Failed to refresh GitHub token".to_string())
        ))
    }

    fn get_authenticated_user(&self, access_token: &str) -> Result<GithubUser> {
        let response = self
            .client
            .get("https://api.github.com/user")
            .header(USER_AGENT, "Helmor")
            .header(ACCEPT, "application/vnd.github+json")
            .header(AUTHORIZATION, format!("Bearer {access_token}"))
            .send()
            .context("Failed to fetch GitHub user profile")?
            .error_for_status()
            .context("GitHub user profile request failed")?;

        response
            .json::<GithubUser>()
            .context("Failed to decode GitHub user profile")
    }

    fn get_primary_email(&self, access_token: &str) -> Result<Option<String>> {
        let response = self
            .client
            .get("https://api.github.com/user/emails")
            .header(USER_AGENT, "Helmor")
            .header(ACCEPT, "application/vnd.github+json")
            .header(AUTHORIZATION, format!("Bearer {access_token}"))
            .send()
            .context("Failed to fetch GitHub email addresses")?;

        if matches!(
            response.status(),
            StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
        ) {
            return Ok(None);
        }

        let emails = response
            .error_for_status()
            .context("GitHub email request failed")?
            .json::<Vec<GithubUserEmail>>()
            .context("Failed to decode GitHub email response")?;

        let mut verified_fallback = None;
        let mut first_email = None;

        for entry in emails {
            if first_email.is_none() {
                first_email = Some(entry.email.clone());
            }

            if entry.primary {
                return Ok(Some(entry.email));
            }

            if verified_fallback.is_none() && entry.verified.unwrap_or(false) {
                verified_fallback = Some(entry.email);
            }
        }

        Ok(verified_fallback.or(first_email))
    }
}

impl GithubIdentityMeta {
    fn into_session(self) -> GithubIdentitySession {
        GithubIdentitySession {
            provider: self.provider,
            github_user_id: self.github_user_id,
            login: self.login,
            name: self.name,
            avatar_url: self.avatar_url,
            primary_email: self.primary_email,
            token_expires_at: self.token_expires_at,
            refresh_token_expires_at: self.refresh_token_expires_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_dir::TEST_ENV_LOCK as TEST_LOCK;
    use rusqlite::Connection;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::fs;
    use std::path::PathBuf;

    struct TestDataDir {
        root: PathBuf,
    }

    impl TestDataDir {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("helmor-auth-test-{name}-{}", uuid::Uuid::new_v4()));
            std::env::set_var("HELMOR_DATA_DIR", root.display().to_string());
            crate::data_dir::ensure_directory_structure().unwrap();
            let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
            crate::schema::ensure_schema(&connection).unwrap();
            Self { root }
        }
    }

    impl Drop for TestDataDir {
        fn drop(&mut self) {
            std::env::remove_var("HELMOR_DATA_DIR");
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[derive(Default)]
    struct MockSecretStore {
        secret: RefCell<Option<StoredIdentitySecret>>,
        deleted: RefCell<bool>,
    }

    impl SecretStore for MockSecretStore {
        fn load(&self) -> Result<Option<StoredIdentitySecret>> {
            Ok(self.secret.borrow().clone())
        }

        fn save(&self, secret: &StoredIdentitySecret) -> Result<()> {
            *self.secret.borrow_mut() = Some(secret.clone());
            *self.deleted.borrow_mut() = false;
            Ok(())
        }

        fn delete(&self) -> Result<()> {
            *self.secret.borrow_mut() = None;
            *self.deleted.borrow_mut() = true;
            Ok(())
        }
    }

    enum MockPollResponse {
        Token(OAuthTokenResponse),
    }

    struct MockGithubClient {
        device_start: Option<DeviceCodeResponse>,
        refresh_result: RefCell<Option<Result<OAuthTokenSuccess, String>>>,
        user: GithubUser,
        primary_email: Option<String>,
        poll_results: RefCell<VecDeque<MockPollResponse>>,
    }

    impl MockGithubClient {
        fn new() -> Self {
            Self {
                device_start: Some(DeviceCodeResponse {
                    device_code: "device-code".to_string(),
                    user_code: "ABCD-EFGH".to_string(),
                    verification_uri: "https://github.com/login/device".to_string(),
                    verification_uri_complete: Some(
                        "https://github.com/login/device?user_code=ABCD-EFGH".to_string(),
                    ),
                    expires_in: 900,
                    interval: Some(5),
                }),
                refresh_result: RefCell::new(None),
                user: GithubUser {
                    id: 42,
                    login: "caspian".to_string(),
                    name: Some("Caspian".to_string()),
                    avatar_url: Some("https://avatars.githubusercontent.com/u/42".to_string()),
                },
                primary_email: Some("caspian@example.com".to_string()),
                poll_results: RefCell::new(VecDeque::new()),
            }
        }
    }

    impl GithubHttpClient for MockGithubClient {
        fn start_device_flow(&self, _client_id: &str) -> Result<DeviceCodeResponse> {
            self.device_start
                .clone()
                .context("device flow response not configured")
        }

        fn exchange_device_code(
            &self,
            _client_id: &str,
            _device_code: &str,
        ) -> Result<OAuthTokenResponse> {
            match self
                .poll_results
                .borrow_mut()
                .pop_front()
                .context("poll result not configured")?
            {
                MockPollResponse::Token(response) => Ok(response),
            }
        }

        fn refresh_user_token(
            &self,
            _client_id: &str,
            _refresh_token: &str,
        ) -> Result<OAuthTokenSuccess> {
            match self
                .refresh_result
                .borrow_mut()
                .take()
                .context("refresh result not configured")?
            {
                Ok(response) => Ok(response),
                Err(message) => Err(anyhow!(message)),
            }
        }

        fn get_authenticated_user(&self, _access_token: &str) -> Result<GithubUser> {
            Ok(self.user.clone())
        }

        fn get_primary_email(&self, _access_token: &str) -> Result<Option<String>> {
            Ok(self.primary_email.clone())
        }
    }

    fn seed_identity(secret_store: &MockSecretStore, expired_access: bool) -> GithubIdentityMeta {
        let meta = GithubIdentityMeta {
            provider: "github-app-device-flow".to_string(),
            github_user_id: 42,
            login: "caspian".to_string(),
            name: Some("Caspian".to_string()),
            avatar_url: Some("https://avatars.githubusercontent.com/u/42".to_string()),
            primary_email: Some("caspian@example.com".to_string()),
            token_expires_at: Some(if expired_access {
                (Utc::now() - Duration::minutes(1)).to_rfc3339()
            } else {
                (Utc::now() + Duration::minutes(10)).to_rfc3339()
            }),
            refresh_token_expires_at: Some((Utc::now() + Duration::days(30)).to_rfc3339()),
        };
        let secret = StoredIdentitySecret {
            access_token: "ghu_access".to_string(),
            refresh_token: Some("ghr_refresh".to_string()),
            access_token_expires_at: meta.token_expires_at.clone(),
            refresh_token_expires_at: meta.refresh_token_expires_at.clone(),
        };
        settings::upsert_setting_json(GITHUB_IDENTITY_META_KEY, &meta).unwrap();
        secret_store.save(&secret).unwrap();
        meta
    }

    #[test]
    fn get_github_identity_session_returns_disconnected_when_nothing_is_stored() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _dir = TestDataDir::new("identity-disconnected");
        let client = MockGithubClient::new();
        let secret_store = MockSecretStore::default();

        let snapshot =
            get_github_identity_session_with(Some("client-id"), &client, &secret_store).unwrap();

        assert_eq!(snapshot, GithubIdentitySnapshot::Disconnected);
    }

    #[test]
    fn get_github_identity_session_refreshes_expired_access_token() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _dir = TestDataDir::new("identity-refresh-success");
        let client = MockGithubClient::new();
        let secret_store = MockSecretStore::default();
        seed_identity(&secret_store, true);
        *client.refresh_result.borrow_mut() = Some(Ok(OAuthTokenSuccess {
            access_token: "ghu_new".to_string(),
            refresh_token: Some("ghr_new".to_string()),
            access_token_expires_at: Some((Utc::now() + Duration::hours(8)).to_rfc3339()),
            refresh_token_expires_at: Some((Utc::now() + Duration::days(30)).to_rfc3339()),
        }));

        let snapshot =
            get_github_identity_session_with(Some("client-id"), &client, &secret_store).unwrap();

        match snapshot {
            GithubIdentitySnapshot::Connected { session } => {
                assert_eq!(session.login, "caspian");
                assert_eq!(
                    session.primary_email.as_deref(),
                    Some("caspian@example.com")
                );
                assert!(session.token_expires_at.is_some());
            }
            other => panic!("unexpected snapshot: {other:?}"),
        }

        let saved = secret_store.load().unwrap().unwrap();
        assert_eq!(saved.access_token, "ghu_new");
        assert_eq!(saved.refresh_token.as_deref(), Some("ghr_new"));
    }

    #[test]
    fn get_github_identity_session_clears_state_when_refresh_fails() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _dir = TestDataDir::new("identity-refresh-failure");
        let client = MockGithubClient::new();
        let secret_store = MockSecretStore::default();
        seed_identity(&secret_store, true);
        *client.refresh_result.borrow_mut() = Some(Err("refresh failed".to_string()));

        let snapshot =
            get_github_identity_session_with(Some("client-id"), &client, &secret_store).unwrap();

        assert_eq!(snapshot, GithubIdentitySnapshot::Disconnected);
        assert!(settings::load_setting_value(GITHUB_IDENTITY_META_KEY)
            .unwrap()
            .is_none());
        assert!(secret_store.load().unwrap().is_none());
    }

    #[test]
    fn start_github_identity_connect_parses_response() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let client = MockGithubClient::new();
        let response = start_github_identity_connect_with(Some("client-id"), &client).unwrap();

        assert_eq!(response.device_code, "device-code");
        assert_eq!(response.user_code, "ABCD-EFGH");
        assert_eq!(response.interval_seconds, 5);
        assert!(response.expires_at.contains('T'));
    }

    #[test]
    fn poll_github_identity_connect_handles_pending_slowdown_and_success() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _dir = TestDataDir::new("identity-poll");
        let client = MockGithubClient::new();
        let secret_store = MockSecretStore::default();
        client.poll_results.borrow_mut().extend([
            MockPollResponse::Token(OAuthTokenResponse {
                access_token: None,
                expires_in: None,
                refresh_token: None,
                refresh_token_expires_in: None,
                error: Some("authorization_pending".to_string()),
                error_description: Some("pending".to_string()),
            }),
            MockPollResponse::Token(OAuthTokenResponse {
                access_token: None,
                expires_in: None,
                refresh_token: None,
                refresh_token_expires_in: None,
                error: Some("slow_down".to_string()),
                error_description: Some("slow down".to_string()),
            }),
            MockPollResponse::Token(OAuthTokenResponse {
                access_token: Some("ghu_access".to_string()),
                expires_in: Some(28800),
                refresh_token: Some("ghr_refresh".to_string()),
                refresh_token_expires_in: Some(15897600),
                error: None,
                error_description: None,
            }),
        ]);

        let first = poll_github_identity_connect_with(
            Some("client-id"),
            &client,
            &secret_store,
            "device-code",
        )
        .unwrap();
        let second = poll_github_identity_connect_with(
            Some("client-id"),
            &client,
            &secret_store,
            "device-code",
        )
        .unwrap();
        let third = poll_github_identity_connect_with(
            Some("client-id"),
            &client,
            &secret_store,
            "device-code",
        )
        .unwrap();

        assert_eq!(
            first,
            GithubIdentityConnectPollResult::Pending {
                interval_seconds: DEFAULT_POLL_INTERVAL_SECONDS,
            }
        );
        assert_eq!(
            second,
            GithubIdentityConnectPollResult::Pending {
                interval_seconds: DEFAULT_POLL_INTERVAL_SECONDS + 5,
            }
        );
        match third {
            GithubIdentityConnectPollResult::Connected { session } => {
                assert_eq!(session.login, "caspian");
                assert_eq!(
                    session.primary_email.as_deref(),
                    Some("caspian@example.com")
                );
            }
            other => panic!("unexpected poll result: {other:?}"),
        }
        assert!(settings::load_setting_value(GITHUB_IDENTITY_META_KEY)
            .unwrap()
            .is_some());
        assert!(secret_store.load().unwrap().is_some());
    }

    #[test]
    fn poll_github_identity_connect_handles_non_retryable_errors() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _dir = TestDataDir::new("identity-poll-errors");
        let client = MockGithubClient::new();
        let secret_store = MockSecretStore::default();
        client
            .poll_results
            .borrow_mut()
            .push_back(MockPollResponse::Token(OAuthTokenResponse {
                access_token: None,
                expires_in: None,
                refresh_token: None,
                refresh_token_expires_in: None,
                error: Some("expired_token".to_string()),
                error_description: Some("expired".to_string()),
            }));

        let result = poll_github_identity_connect_with(
            Some("client-id"),
            &client,
            &secret_store,
            "device-code",
        )
        .unwrap();

        assert_eq!(
            result,
            GithubIdentityConnectPollResult::Error {
                code: "expired_token".to_string(),
                message: "expired".to_string(),
                retryable: false,
            }
        );
    }

    #[test]
    fn disconnect_github_identity_clears_secret_and_metadata() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _dir = TestDataDir::new("identity-disconnect");
        let secret_store = MockSecretStore::default();
        seed_identity(&secret_store, false);

        clear_stored_identity(&secret_store).unwrap();

        assert!(settings::load_setting_value(GITHUB_IDENTITY_META_KEY)
            .unwrap()
            .is_none());
        assert!(secret_store.load().unwrap().is_none());
        assert!(*secret_store.deleted.borrow());
    }
}
