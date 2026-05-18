//! Terminal-side helpers for the gh / glab auth-login flow:
//!   - [`forge_cli_auth_command`] — produces the shell command we hand
//!     off to the embedded Helmor terminal session.
//!   - [`labels_for`] — provider-name / cli-name / connect-action
//!     copy used by [`crate::forge::types::ForgeDetection`].
//!
//! The single-account "is gh/glab globally ready?" probe used to live
//! here too. It's gone — multi-account-era callers want either a list
//! of logged-in accounts ([`crate::forge::accounts::backend_for`]
//! `.list_logins`) or a per-repo binding check; "any account" was
//! never the right question.

use anyhow::{bail, Result};

use super::bundled;
use super::types::{ForgeLabels, ForgeProvider};

pub(crate) fn forge_cli_auth_command(
    provider: ForgeProvider,
    host: Option<&str>,
) -> Result<String> {
    Ok(match provider {
        ForgeProvider::Github => format!("{} auth login", bundled_program_token("gh")?),
        ForgeProvider::Gitlab => {
            let host = host.unwrap_or("gitlab.com");
            // Reject obviously broken hostnames before they reach AppleScript:
            // a newline would let the user inject extra `do script` commands.
            if host.contains(['\n', '\r']) {
                bail!("Invalid hostname (contains newline): {host:?}");
            }
            format!(
                "{} auth login --hostname {host}",
                bundled_program_token("glab")?
            )
        }
        ForgeProvider::Unknown => bail!("Unknown forge provider."),
    })
}

/// Absolute bundled path (shell-quoted). In release builds, missing the
/// bundled binary means the .app payload is broken — fail loudly rather
/// than spawning a Terminal session that immediately dies on
/// `command not found`. In dev (`debug_assertions`), fall back to PATH so
/// `bun run dev` keeps working without a full bundle.
fn bundled_program_token(program: &str) -> Result<String> {
    if let Some(path) = bundled::bundled_path_for(program) {
        return Ok(shell_single_quote(&path.display().to_string()));
    }
    if cfg!(debug_assertions) {
        return Ok(program.to_string());
    }
    bail!("Bundled `{program}` is missing; reinstall Helmor to recover")
}

/// `'foo'\''bar'`-style single quoting safe for /bin/sh.
fn shell_single_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

pub(crate) fn labels_for(provider: ForgeProvider) -> ForgeLabels {
    match provider {
        ForgeProvider::Github => ForgeLabels {
            provider_name: "GitHub".to_string(),
            cli_name: "gh".to_string(),
            change_request_name: "PR".to_string(),
            change_request_full_name: "pull request".to_string(),
            connect_action: "Connect GitHub".to_string(),
        },
        ForgeProvider::Gitlab => ForgeLabels {
            provider_name: "GitLab".to_string(),
            cli_name: "glab".to_string(),
            change_request_name: "MR".to_string(),
            change_request_full_name: "merge request".to_string(),
            connect_action: "Connect GitLab".to_string(),
        },
        ForgeProvider::Unknown => ForgeLabels {
            provider_name: "Git".to_string(),
            cli_name: String::new(),
            change_request_name: "change request".to_string(),
            change_request_full_name: "change request".to_string(),
            connect_action: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_single_quote_handles_embedded_single_quotes() {
        assert_eq!(shell_single_quote("/usr/bin/gh"), "'/usr/bin/gh'");
        assert_eq!(
            shell_single_quote("/Apps/Tom's Stuff/Helmor.app/Contents/Resources/vendor/gh/gh"),
            "'/Apps/Tom'\\''s Stuff/Helmor.app/Contents/Resources/vendor/gh/gh'"
        );
        assert_eq!(shell_single_quote("a'b'c"), "'a'\\''b'\\''c'");
    }
}
