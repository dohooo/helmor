use anyhow::Result;
use serde_json::Value;

use crate::service;

use super::super::response::format_json_response;

pub(super) fn tool_data_info(args: &Value) -> Result<String> {
    let info = service::get_data_info()?;
    format_json_response(args, &info, None)
}
