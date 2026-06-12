pub mod postgres;

use serde::{Deserialize, Serialize};

pub type SessionId = String;
pub type ProfileId = String;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: ProfileId,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub dbname: String,
    pub user: String,
    /// "disable" | "prefer" | "require"
    #[serde(default = "default_sslmode")]
    pub sslmode: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub is_prod: bool,
}

fn default_sslmode() -> String {
    "prefer".into()
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    /// pg type oid; 0 when unknown (simple protocol)
    pub type_oid: u32,
    /// source table oid; 0 = not a plain table column (computed/joined expr)
    pub table_oid: u32,
    /// attribute number within source table; 0 = none
    pub attnum: i16,
}

/// One executed statement's outcome. Values are wire-text (what psql shows); None = NULL.
#[derive(Debug, Serialize)]
pub struct StatementResult {
    pub index: u32,
    pub sql: String,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Option<String>>>,
    pub affected: Option<u64>,
    pub ms: f64,
}

#[derive(Debug, Serialize)]
pub struct ExecOutcome {
    pub statements: Vec<StatementResult>,
}

#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    #[error("{message}")]
    Db {
        message: String,
        /// 1-based byte position into the failing statement, from PG error field
        position: Option<u32>,
        code: Option<String>,
    },
    #[error("connection failed: {0}")]
    Connect(String),
    #[error("no such session")]
    NoSession,
    #[error("{0}")]
    Internal(String),
}

impl serde::Serialize for DriverError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("DriverError", 3)?;
        match self {
            DriverError::Db { message, position, code } => {
                st.serialize_field("message", message)?;
                st.serialize_field("position", position)?;
                st.serialize_field("code", code)?;
            }
            other => {
                st.serialize_field("message", &other.to_string())?;
                st.serialize_field("position", &Option::<u32>::None)?;
                st.serialize_field("code", &Option::<String>::None)?;
            }
        }
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, DriverError>;
