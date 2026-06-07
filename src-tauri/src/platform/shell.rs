//! Shell command formatting for embedded auth/login terminals.

use std::path::Path;

pub fn quote_posix_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn quote_path(path: &Path) -> String {
    quote_posix_arg(&path.display().to_string())
}

pub fn format_boot_command(command: &str) -> String {
    #[cfg(windows)]
    {
        format!("& {command}")
    }

    #[cfg(not(windows))]
    {
        command.to_string()
    }
}

pub fn boot_input(command: &str) -> String {
    format!("{}; exit\n", format_boot_command(command))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_posix_arg_wraps_plain_value() {
        assert_eq!(
            quote_posix_arg("/usr/local/bin/helmor"),
            "'/usr/local/bin/helmor'"
        );
    }

    #[test]
    fn quote_posix_arg_escapes_single_quotes() {
        assert_eq!(
            quote_posix_arg("/Users/me/foo's app"),
            "'/Users/me/foo'\\''s app'"
        );
    }

    #[test]
    fn boot_input_preserves_unix_command_shape() {
        assert_eq!(boot_input("codex login"), "codex login; exit\n");
    }
}
