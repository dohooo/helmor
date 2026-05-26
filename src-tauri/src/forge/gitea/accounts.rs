use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use crate::forge::accounts::{AuthCheck, ForgeAccount, ForgeAccountBackend, RepoAccess};
use crate::forge::command::CommandOutput;
use crate::forge::types::ForgeProvider;

use super::api::{
    command_detail, looks_like_auth_error, looks_like_missing_error, run_tea, tea_api,
};
use super::types::GiteaUser;

pub(crate) static BACKEND: GiteaAccountBackend = GiteaAccountBackend;

pub(crate) struct GiteaAccountBackend;

#[derive(Debug, Clone, Deserialize)]
struct TeaLoginRow {
    name: String,
    url: String,
    user: String,
    default: String,
}

impl ForgeAccountBackend for GiteaAccountBackend {
    fn list_accounts(&self, _hosts_hint: &[String]) -> Result<Vec<ForgeAccount>> {
        let logins = list_gitea_logins_full()?;
        let mut out = Vec::with_capacity(logins.len());
        for login in logins {
            let host = host_from_url(&login.url)?;
            let profile = fetch_profile_for_login(&login.name, &host, &login.user).ok();
            out.push(ForgeAccount {
                provider: ForgeProvider::Gitea,
                host,
                login: login.user.clone(),
                name: profile
                    .as_ref()
                    .and_then(|user| user.full_name.clone())
                    .filter(|value| !value.trim().is_empty()),
                avatar_url: profile.as_ref().and_then(|user| user.avatar_url.clone()),
                email: profile.as_ref().and_then(|user| user.email.clone()),
                active: login.default == "true",
            });
        }
        Ok(out)
    }

    fn list_logins(&self, host: &str) -> Result<Vec<String>> {
        Ok(list_gitea_logins_full()?
            .into_iter()
            .filter_map(|login| (host_from_url(&login.url).ok()?.eq(host)).then_some(login.user))
            .collect())
    }

    fn check_auth(&self, host: &str, login: &str) -> AuthCheck {
        match self.list_logins(host) {
            Ok(logins) => {
                if logins.iter().any(|candidate| candidate == login) {
                    AuthCheck::LoggedIn
                } else {
                    AuthCheck::LoggedOut
                }
            }
            Err(_) => AuthCheck::Indeterminate,
        }
    }

    fn repo_access(&self, host: &str, login: &str, owner: &str, name: &str) -> Result<RepoAccess> {
        let Some(login_name) = find_login_name(host, login)? else {
            return Ok(RepoAccess::None);
        };
        let path = format!("/repos/{owner}/{name}");
        let output = tea_api(&login_name, [path.as_str()])?;
        if !output.success {
            let detail = command_detail(&output);
            if looks_like_auth_error(&detail) || looks_like_missing_error(&detail) {
                return Ok(RepoAccess::None);
            }
            return Err(anyhow!("tea api {path} failed: {detail}"));
        }
        Ok(RepoAccess::Probable)
    }

    fn fetch_profile(&self, host: &str, login: &str) -> Result<ForgeAccount> {
        let Some(login_name) = find_login_name(host, login)? else {
            return Err(anyhow!("No Gitea login for {host} / {login}"));
        };
        let user = fetch_profile_for_login(&login_name, host, login)?;
        Ok(ForgeAccount {
            provider: ForgeProvider::Gitea,
            host: host.to_string(),
            login: user
                .login
                .or(user.user_name)
                .unwrap_or_else(|| login.to_string()),
            name: user.full_name,
            avatar_url: user.avatar_url,
            email: user.email,
            active: true,
        })
    }

    fn run_cli(&self, _host: &str, login: &str, args: &[&str]) -> Result<CommandOutput> {
        let mut full_args = vec!["--login", login];
        full_args.extend_from_slice(args);
        run_tea(full_args)
    }
}

fn list_gitea_logins_full() -> Result<Vec<TeaLoginRow>> {
    let output = run_tea(["login", "ls", "--output", "json"])?;
    if !output.success {
        return Err(anyhow!(
            "`tea login ls --output json` failed: {}",
            command_detail(&output)
        ));
    }
    serde_json::from_str::<Vec<TeaLoginRow>>(&output.stdout)
        .context("Failed to decode tea login list output")
}

fn fetch_profile_for_login(login_name: &str, _host: &str, _user: &str) -> Result<GiteaUser> {
    let output = tea_api(login_name, ["/user"])?;
    if !output.success {
        return Err(anyhow!(
            "`tea api /user` failed: {}",
            command_detail(&output)
        ));
    }
    serde_json::from_str::<GiteaUser>(&output.stdout).context("Failed to decode Gitea /user")
}

fn host_from_url(url: &str) -> Result<String> {
    let parsed = url::Url::parse(url).with_context(|| format!("Invalid Gitea login URL: {url}"))?;
    parsed
        .host_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow!("Missing host in Gitea login URL: {url}"))
}

fn find_login_name(host: &str, login: &str) -> Result<Option<String>> {
    for row in list_gitea_logins_full()? {
        if host_from_url(&row.url).ok().as_deref() == Some(host) && row.user == login {
            return Ok(Some(row.name));
        }
    }
    Ok(None)
}

pub(crate) fn invalidate_caches_for_host(_host: &str) {}
