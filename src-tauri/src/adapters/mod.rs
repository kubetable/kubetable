pub mod cassandra;
pub mod cockroachdb;
pub mod mongodb;
pub mod mysql;
pub mod postgres;
pub mod redis;
pub mod registry;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaNode {
    pub name: String,
    pub kind: SchemaNodeKind,
    pub children: Vec<SchemaNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SchemaNodeKind {
    Database,
    Schema,
    Table,
    Column,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub user: String,
    pub password: String,
    pub database: Option<String>,
    #[serde(default, rename = "readOnly")]
    pub read_only: bool,
}

#[async_trait]
pub trait DbAdapter: Send + Sync {
    fn type_name(&self) -> &'static str;
    fn port_hint(&self) -> u16;

    async fn test_connection(&self, host: &str, port: u16, creds: &Credentials) -> crate::error::Result<()>;
    async fn query(&self, host: &str, port: u16, creds: &Credentials, sql: &str) -> crate::error::Result<QueryResult>;
    async fn schema(&self, host: &str, port: u16, creds: &Credentials) -> crate::error::Result<Vec<SchemaNode>>;
}
