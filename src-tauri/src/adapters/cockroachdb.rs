use async_trait::async_trait;

use super::{postgres::PostgresAdapter, Credentials, DbAdapter, QueryResult, SchemaNode};

pub struct CockroachDbAdapter;

#[async_trait]
impl DbAdapter for CockroachDbAdapter {
    fn type_name(&self) -> &'static str {
        "cockroachdb"
    }

    fn port_hint(&self) -> u16 {
        26257
    }

    async fn test_connection(&self, host: &str, port: u16, creds: &Credentials) -> crate::error::Result<()> {
        PostgresAdapter.test_connection(host, port, creds).await
    }

    async fn query(&self, host: &str, port: u16, creds: &Credentials, sql: &str) -> crate::error::Result<QueryResult> {
        PostgresAdapter.query(host, port, creds, sql).await
    }

    async fn schema(&self, host: &str, port: u16, creds: &Credentials) -> crate::error::Result<Vec<SchemaNode>> {
        PostgresAdapter.schema(host, port, creds).await
    }
}
