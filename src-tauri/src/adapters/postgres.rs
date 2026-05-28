use async_trait::async_trait;
use serde_json::Value;
use tokio_postgres::{types::Type, NoTls};

use super::{Credentials, DbAdapter, QueryResult, SchemaNode, SchemaNodeKind};

pub struct PostgresAdapter;

#[async_trait]
impl DbAdapter for PostgresAdapter {
    fn type_name(&self) -> &'static str {
        "postgres"
    }

    fn port_hint(&self) -> u16 {
        5432
    }

    async fn test_connection(&self, host: &str, port: u16, creds: &Credentials) -> crate::error::Result<()> {
        let db = creds.database.as_deref().unwrap_or("postgres");
        let conn_str = format!(
            "host={} port={} user={} password={} dbname={}",
            host, port, creds.user, creds.password, db
        );
        let (_, conn) = tokio_postgres::connect(&conn_str, NoTls).await?;
        tokio::spawn(conn);
        Ok(())
    }

    async fn query(&self, host: &str, port: u16, creds: &Credentials, sql: &str) -> crate::error::Result<QueryResult> {
        let db = creds.database.as_deref().unwrap_or("postgres");
        let conn_str = format!(
            "host={} port={} user={} password={} dbname={}",
            host, port, creds.user, creds.password, db
        );
        let (mut client, conn) = tokio_postgres::connect(&conn_str, NoTls).await?;
        tokio::spawn(conn);

        let rows = if creds.read_only {
            let tx = client.build_transaction().read_only(true).start().await?;
            let rows = tx.query(sql, &[]).await?;
            tx.commit().await?;
            rows
        } else {
            client.query(sql, &[]).await?
        };

        if rows.is_empty() {
            return Ok(QueryResult { columns: vec![], rows: vec![], row_count: 0 });
        }

        let columns: Vec<String> = rows[0].columns().iter().map(|c| c.name().to_string()).collect();

        let data: Vec<Vec<Value>> = rows
            .iter()
            .map(|row| {
                row.columns()
                    .iter()
                    .enumerate()
                    .map(|(i, col)| pg_value_to_json(row, i, col.type_()))
                    .collect()
            })
            .collect();

        let row_count = data.len();
        Ok(QueryResult { columns, rows: data, row_count })
    }

    async fn schema(&self, host: &str, port: u16, creds: &Credentials) -> crate::error::Result<Vec<SchemaNode>> {
        let db = creds.database.as_deref().unwrap_or("postgres");
        let conn_str = format!(
            "host={} port={} user={} password={} dbname={}",
            host, port, creds.user, creds.password, db
        );
        let (client, conn) = tokio_postgres::connect(&conn_str, NoTls).await?;
        tokio::spawn(conn);

        let rows = client
            .query(
                "SELECT table_schema, table_name, column_name, data_type \
                 FROM information_schema.columns \
                 WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
                 ORDER BY table_schema, table_name, ordinal_position",
                &[],
            )
            .await?;

        let mut schemas: indexmap::IndexMap<String, indexmap::IndexMap<String, Vec<SchemaNode>>> =
            indexmap::IndexMap::new();

        for row in &rows {
            let schema: String = row.get(0);
            let table: String = row.get(1);
            let column: String = row.get(2);
            let data_type: String = row.get(3);

            schemas
                .entry(schema)
                .or_default()
                .entry(table)
                .or_default()
                .push(SchemaNode {
                    name: format!("{}: {}", column, data_type),
                    kind: SchemaNodeKind::Column,
                    children: vec![],
                });
        }

        let result = schemas
            .into_iter()
            .map(|(schema_name, tables)| SchemaNode {
                name: schema_name,
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

fn pg_value_to_json(row: &tokio_postgres::Row, idx: usize, ty: &Type) -> Value {
    match ty {
        &Type::BOOL => row.try_get::<_, bool>(idx).map(Value::Bool).unwrap_or(Value::Null),
        &Type::INT2 => row.try_get::<_, i16>(idx).map(|v| Value::Number(v.into())).unwrap_or(Value::Null),
        &Type::INT4 => row.try_get::<_, i32>(idx).map(|v| Value::Number(v.into())).unwrap_or(Value::Null),
        &Type::INT8 => row.try_get::<_, i64>(idx).map(|v| Value::Number(v.into())).unwrap_or(Value::Null),
        &Type::FLOAT4 => row
            .try_get::<_, f32>(idx)
            .ok()
            .and_then(|v| serde_json::Number::from_f64(v as f64))
            .map(Value::Number)
            .unwrap_or(Value::Null),
        &Type::FLOAT8 => row
            .try_get::<_, f64>(idx)
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        &Type::JSON | &Type::JSONB => row.try_get::<_, Value>(idx).unwrap_or(Value::Null),
        _ => row
            .try_get::<_, String>(idx)
            .map(Value::String)
            .unwrap_or(Value::Null),
    }
}
