use std::fmt;
use std::str::FromStr;

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrSyncState {
    #[default]
    None,
    Open,
    Closed,
    Merged,
}

impl PrSyncState {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Open => "open",
            Self::Closed => "closed",
            Self::Merged => "merged",
        }
    }
}

impl fmt::Display for PrSyncState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug)]
pub struct UnknownPrSyncState(pub String);

impl fmt::Display for UnknownPrSyncState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown workspace pr_sync_state: {:?}", self.0)
    }
}

impl std::error::Error for UnknownPrSyncState {}

impl FromStr for PrSyncState {
    type Err = UnknownPrSyncState;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "none" => Ok(Self::None),
            "open" => Ok(Self::Open),
            "closed" => Ok(Self::Closed),
            "merged" => Ok(Self::Merged),
            _ => Err(UnknownPrSyncState(s.to_string())),
        }
    }
}

impl FromSql for PrSyncState {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        s.parse()
            .map_err(|e: UnknownPrSyncState| FromSqlError::Other(Box::new(e)))
    }
}

impl ToSql for PrSyncState {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            self.as_str().as_bytes(),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_storage_values() {
        assert_eq!("none".parse::<PrSyncState>().unwrap(), PrSyncState::None);
        assert_eq!("OPEN".parse::<PrSyncState>().unwrap(), PrSyncState::Open);
        assert_eq!(
            " merged ".parse::<PrSyncState>().unwrap(),
            PrSyncState::Merged
        );
    }
}
