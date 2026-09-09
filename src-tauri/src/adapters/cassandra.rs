use async_trait::async_trait;
use base64::{engine::general_purpose, Engine as _};
use openssl::ssl::{SslContext, SslMethod, SslVerifyMode};
use scylla::frame::response::result::CqlValue;
use scylla::transport::session::{AddressTranslator, TranslationError};
use scylla::transport::topology::UntranslatedPeer;
use scylla::{Session, SessionBuilder};
use serde_json::Value;
use std::net::SocketAddr;
use std::sync::Arc;

use super::{Credentials, DbAdapter, QueryResult, SchemaNode, SchemaNodeKind};

pub struct CassandraAdapter;

/// Routes all peer discovery addresses back to the single port-forward endpoint.
/// Without this, scylla tries to connect to internal pod IPs after peer discovery,
/// which are unreachable from outside the cluster.
struct PortForwardTranslator(SocketAddr);

#[async_trait]
impl AddressTranslator for PortForwardTranslator {
    async fn translate_address(
        &self,
        _peer: &UntranslatedPeer,
    ) -> Result<SocketAddr, TranslationError> {
        Ok(self.0)
    }
}

async fn build_session(host: &str, port: u16, creds: &Credentials, tls: bool) -> crate::error::Result<Session> {
    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .map_err(|e: std::net::AddrParseError| crate::error::AppError::Cassandra(e.to_string()))?;

    let mut builder = SessionBuilder::new()
        .known_node(format!("{}:{}", host, port))
        .address_translator(Arc::new(PortForwardTranslator(addr)));

    if !creds.user.is_empty() {
        builder = builder.user(&creds.user, &creds.password);
    }
    if tls {
        let mut ctx = SslContext::builder(SslMethod::tls())
            .map_err(|e| crate::error::AppError::Cassandra(e.to_string()))?;
        ctx.set_verify(SslVerifyMode::NONE);
        builder = builder.ssl_context(Some(ctx.build()));
    }
    builder.build().await.map_err(|e| crate::error::AppError::Cassandra(e.to_string()))
}

async fn make_session(host: &str, port: u16, creds: &Credentials) -> crate::error::Result<Session> {
    // k8ssandra always runs TLS on port 9042; go directly to TLS.
    match build_session(host, port, creds, true).await {
        Ok(s) => Ok(s),
        Err(_) => build_session(host, port, creds, false).await,
    }
}

fn cql_to_json(val: Option<CqlValue>) -> Value {
    match val {
        None => Value::Null,
        Some(v) => match v {
            CqlValue::Ascii(s) | CqlValue::Text(s) => Value::String(s),
            CqlValue::Boolean(b) => Value::Bool(b),
            CqlValue::Int(i) => Value::Number(i.into()),
            CqlValue::BigInt(i) => Value::Number(i.into()),
            CqlValue::SmallInt(i) => Value::Number(i32::from(i).into()),
            CqlValue::TinyInt(i) => Value::Number(i32::from(i).into()),
            CqlValue::Float(f) => serde_json::Number::from_f64(f as f64)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            CqlValue::Double(d) => serde_json::Number::from_f64(d)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            CqlValue::Blob(b) => Value::String(general_purpose::STANDARD.encode(&b)),
            CqlValue::Uuid(u) => Value::String(u.to_string()),
            CqlValue::Timeuuid(u) => Value::String(u.to_string()),
            CqlValue::List(items) => {
                Value::Array(items.into_iter().map(|v| cql_to_json(Some(v))).collect())
            }
            CqlValue::Set(items) => {
                Value::Array(items.into_iter().map(|v| cql_to_json(Some(v))).collect())
            }
            CqlValue::Map(pairs) => {
                let mut map = serde_json::Map::new();
                for (k, v) in pairs {
                    let key = match &k {
                        CqlValue::Text(s) | CqlValue::Ascii(s) => s.clone(),
                        other => format!("{:?}", other),
                    };
                    map.insert(key, cql_to_json(Some(v)));
                }
                Value::Object(map)
            }
            other => Value::String(format!("{:?}", other)),
        },
    }
}

#[async_trait]
impl DbAdapter for CassandraAdapter {
    fn type_name(&self) -> &'static str {
        "cassandra"
    }

    fn port_hint(&self) -> u16 {
        9042
    }

    async fn test_connection(
        &self,
        host: &str,
        port: u16,
        creds: &Credentials,
    ) -> crate::error::Result<()> {
        let session = make_session(host, port, creds).await?;
        session
            .query("SELECT release_version FROM system.local", &[])
            .await
            .map_err(|e| crate::error::AppError::Cassandra(e.to_string()))?;
        Ok(())
    }

    async fn query(
        &self,
        host: &str,
        port: u16,
        creds: &Credentials,
        cql: &str,
    ) -> crate::error::Result<QueryResult> {
        if creds.read_only {
            let upper = cql.trim_start().to_ascii_uppercase();
            if !upper.starts_with("SELECT") && !upper.starts_with("DESCRIBE") {
                return Err(crate::error::AppError::Cassandra(
                    "Read-only mode: only SELECT statements are allowed".into(),
                ));
            }
        }

        let session = make_session(host, port, creds).await?;
        let result = session
            .query(cql, &[])
            .await
            .map_err(|e| crate::error::AppError::Cassandra(e.to_string()))?;

        let columns: Vec<String> = result
            .col_specs
            .iter()
            .map(|spec| spec.name.clone())
            .collect();

        let rows: Vec<Vec<Value>> = result
            .rows
            .unwrap_or_default()
            .into_iter()
            .map(|row| row.columns.into_iter().map(cql_to_json).collect())
            .collect();

        let row_count = rows.len();
        Ok(QueryResult { columns, rows, row_count })
    }

    async fn schema(
        &self,
        host: &str,
        port: u16,
        creds: &Credentials,
    ) -> crate::error::Result<Vec<SchemaNode>> {
        let session = make_session(host, port, creds).await?;

        let result = session
            .query(
                "SELECT keyspace_name, table_name, column_name, type \
                 FROM system_schema.columns",
                &[],
            )
            .await
            .map_err(|e| crate::error::AppError::Cassandra(e.to_string()))?;

        let mut keyspaces: indexmap::IndexMap<
            String,
            indexmap::IndexMap<String, Vec<SchemaNode>>,
        > = indexmap::IndexMap::new();

        for row in result.rows.unwrap_or_default() {
            let mut cols = row.columns.into_iter();
            let keyspace = match cols.next().flatten() {
                Some(CqlValue::Text(s)) => s,
                _ => continue,
            };
            // Skip system keyspaces
            if keyspace.starts_with("system") {
                continue;
            }
            let table = match cols.next().flatten() {
                Some(CqlValue::Text(s)) => s,
                _ => continue,
            };
            let column = match cols.next().flatten() {
                Some(CqlValue::Text(s)) => s,
                _ => continue,
            };
            let col_type = match cols.next().flatten() {
                Some(CqlValue::Text(s)) => s,
                _ => String::from("unknown"),
            };

            keyspaces
                .entry(keyspace)
                .or_default()
                .entry(table)
                .or_default()
                .push(SchemaNode {
                    name: format!("{}: {}", column, col_type),
                    kind: SchemaNodeKind::Column,
                    children: vec![],
                });
        }

        let result = keyspaces
            .into_iter()
            .map(|(ks_name, tables)| SchemaNode {
                name: ks_name,
                kind: SchemaNodeKind::Schema,
                children: tables
                    .into_iter()
                    .map(|(table_name, columns)| SchemaNode {
                        name: table_name,
                        kind: SchemaNodeKind::Table,
                        children: columns,
                    })
                    .collect(),
            })
            .collect();

        Ok(result)
    }
}
