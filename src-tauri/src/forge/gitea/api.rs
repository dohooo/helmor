use crate::{
    error::{AnyhowCodedExt, ErrorCode},
    forge::command::{run_command, CommandOutput},
};

pub(super) fn tea_api<'a>(
    login: &str,
    args: impl IntoIterator<Item = &'a str>,
) -> anyhow::Result<CommandOutput> {
    let mut full_args = vec!["api".to_string(), "--login".to_string(), login.to_string()];
    full_args.extend(args.into_iter().map(str::to_string));
    let output = run_command("tea", full_args).map_err(anyhow::Error::new)?;
    if !output.success && output.status.is_none() {
        return Err(anyhow::anyhow!("failed to run tea api").with_code(ErrorCode::ForgeOnboarding));
    }
    Ok(output)
}

pub(super) fn run_tea<'a>(
    args: impl IntoIterator<Item = &'a str>,
) -> anyhow::Result<CommandOutput> {
    run_command("tea", args).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            anyhow::anyhow!(error.to_string()).with_code(ErrorCode::ForgeOnboarding)
        } else {
            anyhow::Error::new(error)
        }
    })
}

pub(super) fn command_detail(output: &CommandOutput) -> String {
    crate::forge::command::command_detail(output)
}

pub(super) fn encode_query_value(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

pub(super) fn looks_like_auth_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("401")
        || normalized.contains("403")
        || normalized.contains("forbidden")
        || normalized.contains("unauthorized")
        || normalized.contains("authentication required")
        || normalized.contains("not logged in")
        || normalized.contains("token")
}

pub(super) fn looks_like_missing_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("404") || normalized.contains("not found")
}
