//! OpenAI-compatible chat client on top of the bundled `llama-server`,
//! plus the truncation helper that keeps prompts inside the active
//! model's context window. Implemented as additional `impl Manager`
//! blocks so callers see a single API surface.

use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::json;

use super::{manager::Manager, text::truncate_for_log, API_MODEL, CHAT_MAX_TOKENS};

impl Manager {
    /// Single-shot blocking chat call. Returns the assistant message
    /// content as a trimmed string.
    pub(crate) fn chat(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        timeout: Duration,
    ) -> Result<String> {
        let (endpoint, token) = self
            .current_endpoint_and_token()
            .context("Local LLM server is not running")?;

        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .build()
            .context("build Local LLM HTTP client")?;
        let response = client
            .post(format!("{endpoint}/v1/chat/completions"))
            .bearer_auth(token)
            .json(&json!({
                "model": API_MODEL,
                "messages": [
                    { "role": "system", "content": system_prompt },
                    { "role": "user", "content": user_prompt }
                ],
                "temperature": 0.0,
                "max_tokens": CHAT_MAX_TOKENS
            }))
            .send()
            .context("call Local LLM chat endpoint")?;

        // Always pull the body — llama-server stuffs the real reason
        // (context-overflow, schema mismatch, …) into the response body.
        let status = response.status();
        let raw_body = response
            .text()
            .unwrap_or_else(|error| format!("<failed to read body: {error}>"));
        if !status.is_success() {
            anyhow::bail!(
                "Local LLM chat returned HTTP {} — {}",
                status,
                summarize_error_body(&raw_body)
            );
        }
        let body: serde_json::Value = serde_json::from_str(&raw_body)
            .with_context(|| format!("parse Local LLM chat response (raw={raw_body})"))?;
        let content = body["choices"][0]["message"]["content"]
            .as_str()
            .or_else(|| body["choices"][0]["message"]["reasoning_content"].as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if content.is_empty() {
            anyhow::bail!("Local LLM chat returned an empty message");
        }
        Ok(content)
    }

    /// Trim `user_message` so a `(system_prompt, user_message)` chat
    /// call fits inside the active model's context window. Drops a
    /// wedge from the middle and inserts a `[…truncated…]` marker.
    ///
    /// Uses a `~4 chars/token` proxy. Reserves `CHAT_MAX_TOKENS` plus
    /// ~256 tokens of envelope. Never fails — degrades to "keep at
    /// least 256 chars of tail" when the budget is pathological.
    pub fn fit_user_message_to_context(&self, system_prompt: &str, user_message: &str) -> String {
        const CHARS_PER_TOKEN: usize = 4;
        const RESERVED_TOKENS: usize = CHAT_MAX_TOKENS as usize + 256;
        const MIN_USER_CHARS: usize = 256;

        let context_tokens = self.current_context_tokens() as usize;
        if context_tokens == 0 {
            return user_message.to_string();
        }
        let total_chars = context_tokens.saturating_mul(CHARS_PER_TOKEN);
        let system_chars = system_prompt.chars().count();
        let reserved_chars = RESERVED_TOKENS.saturating_mul(CHARS_PER_TOKEN) + system_chars;
        let max_user_chars = total_chars
            .saturating_sub(reserved_chars)
            .max(MIN_USER_CHARS);

        super::truncate_middle(user_message, max_user_chars)
    }
}

/// Pull a human-readable message out of a llama-server error body. The
/// server speaks OpenAI-shaped JSON; falls back to raw text otherwise.
fn summarize_error_body(raw: &str) -> String {
    const MAX_LEN: usize = 512;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "<empty body>".to_string();
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(message) = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            return truncate_for_log(message, MAX_LEN);
        }
        if let Some(message) = value.get("message").and_then(|m| m.as_str()) {
            return truncate_for_log(message, MAX_LEN);
        }
    }
    truncate_for_log(trimmed, MAX_LEN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_error_body_extracts_openai_shape() {
        let raw = r#"{"error":{"message":"the request exceeds the available context size (4096 tokens). prompt requires 5120 tokens.","type":"invalid_request_error","code":400}}"#;
        let summary = summarize_error_body(raw);
        assert!(summary.contains("exceeds the available context size"));
        assert!(!summary.contains("invalid_request_error"));
    }

    #[test]
    fn summarize_error_body_falls_back_to_plain_text() {
        let summary = summarize_error_body("oom: cannot allocate kv cache");
        assert_eq!(summary, "oom: cannot allocate kv cache");
    }

    #[test]
    fn summarize_error_body_handles_empty() {
        assert_eq!(summarize_error_body(""), "<empty body>");
        assert_eq!(summarize_error_body("   \n  "), "<empty body>");
    }
}
