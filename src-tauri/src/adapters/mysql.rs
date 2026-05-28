use async_trait::async_trait;
use mysql_async::{prelude::*, Opts, OptsBuilder, Pool, Row, Value as MysqlValue};
use serde_json::Value;

use super::{Credentials, DbAdapter, QueryResult, SchemaNode, SchemaNodeKind};

pub struct MySqlAdapter;

fn make_opts(host: &str, port: u16, creds: &Credentials) -> Opts {
    let builder = OptsBuilder::default()
        .ip_or_hostname(host)
        .tcp_port(port)
        .user(Some(creds.user.clone()))
        .pass(Some(creds.password.clone()))
        .db_name(creds.database.clone());
    Opts::from(builder)
}

fn mysql_value_to_json(v: MysqlValue) -> Value {
    match v {
        MysqlValue::NULL => Value::Null,
        MysqlValue::Bytes(b) => Value::String(String::from_utf8_lossy(&b).into_owned()),
        MysqlValue::Int(i) => Value::Number(i.into()),
        MysqlValue::UInt(u) => Value::Number(u.into()),
        MysqlValue::Float(f) => serde_json::Number::from_f64(f as f64)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        MysqlValue::Double(d) => serde_json::Number::from_f64(d)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        MysqlValue::Date(yr, mo, day, h, m, s, _) => {
            Value::String(format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", yr, mo, day, h, m, s))
        }
        MysqlValue::Time(neg, days, h, m, s, _) => {
            let sign = if neg { "-" } else { "" };
            Value::String(format!("{}{:02}:{:02}:{:02}", sign, days * 24 + h as u32, m, s))
        }
    }
}

#[async_trait]
impl DbAdapter for MySqlAdapter {
    fn type_name(&self) -> &'static str {
        "mysql"
    }

    fn port_hint(&self) -> u16 {
        3306
    }

    async fn test_connection(&self, host: &str, port: u16, creds: &Credentials) -> crate::error::Result<()> {
        let opts = make_opts(host, port, creds);
        let pool = Pool::new(opts);
        let _conn = pool
            .get_conn()
            .await
            .map_err(|e| crate::error::AppError::MySql(e.to_string()))?;
        Ok(())
    }

    async fn query(&self, host: &str, port: u16, creds: &Credentials, sql: &str) -> crate::error::Result<QueryResult> {
        let opts = make_opts(host, port, creds);
        let pool = Pool::new(opts);
        let mut conn = pool
            .get_conn()
            .await
            .map_err(|e| crate::error::AppError::MySql(e.to_string()))?;

        if creds.read_only {
            conn.query_drop("SET SESSION TRANSACTION READ ONLY")
                .await
                .map_err(|e| crate::error::AppError::MySql(e.to_string()))?;
        }

        let mut result = conn
            .query_iter(sql)
            .await
            .map_err(|e| crate::error::AppError::MySql(e.to_string()))?;

        // Collect column names before consuming rows
        let columns: Vec<String> = result
            .columns()
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(|c| c.name_str().into_owned())
            .collect();

        let raw_rows: Vec<Row> = result
            .collect()
            .await
            .map_err(|e| crate::error::AppError::MySql(e.to_string()))?;

        if columns.is_empty() {
            return Ok(QueryResult { columns: vec![], rows: vec![], row_count: 0 });
        }

        let data: Vec<Vec<Value>> = raw_rows
            .into_iter()
            .map(|row| {
                row.unwrap()
                    .into_iter()
                    .map(mysql_value_to_json)
                    .collect()
            })
            .collect();

        let row_count = data.len();
        Ok(QueryResult { columns, rows: data, row_count })
    }

    async fn schema(&self, host: &str, port: u16, creds: &Credentials) -> crate::error::Result<Vec<SchemaNode>> {
        let opts = make_opts(host, port, creds);
        let pool = Pool::new(opts);
        let mut conn = pool
            .get_conn()
            .await
            .map_err(|e| crate::error::AppError::MySql(e.to_string()))?;

        let rows: Vec<(String, String, String)> = conn
            .query(
                "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME \
                 FROM INFORMATION_SCHEMA.COLUMNS \
                 WHERE TABLE_SCHEMA NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys') \
                 ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION",
            )
            .await
            .map_err(|e| crate::error::AppError::MySql(e.to_string()))?;

        let mut databases: indexmap::IndexMap<String, indexmap::IndexMap<String, Vec<SchemaNode>>> =
            indexmap::IndexMap::new();

        for (db_name, table_name, column_name) in rows {
            databases
                .entry(db_name)
                .or_default()
                .entry(table_name)
                .or_default()
                .push(SchemaNode {
                    name: column_name,
                    kind: SchemaNodeKind::Column,
                    children: vec![],
                });
        }

        let result = databases
            .into_iter()
            .map(|(db_name, tables)| SchemaNode {
                name: db_name,
                kind: SchemaNodeKind::Database,
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
