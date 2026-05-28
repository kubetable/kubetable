use async_trait::async_trait;
use serde_json::Value;

use super::{Credentials, DbAdapter, QueryResult, SchemaNode, SchemaNodeKind};

pub struct RedisAdapter;

fn make_url(host: &str, port: u16, creds: &Credentials, db_index: Option<u32>) -> String {
    let db_suffix = db_index.map(|i| format!("/{}", i)).unwrap_or_default();
    if creds.password.is_empty() {
        format!("redis://{}:{}{}", host, port, db_suffix)
    } else {
        format!("redis://:{}@{}:{}{}", creds.password, host, port, db_suffix)
    }
}

fn redis_value_to_json(v: redis::Value) -> Value {
    match v {
        redis::Value::Nil => Value::Null,
        redis::Value::Int(i) => Value::Number(i.into()),
        redis::Value::BulkString(b) => Value::String(String::from_utf8_lossy(&b).into_owned()),
        redis::Value::SimpleString(s) => Value::String(s),
        redis::Value::Okay => Value::String("OK".into()),
        redis::Value::Array(arr) => Value::Array(arr.into_iter().map(redis_value_to_json).collect()),
        redis::Value::Map(pairs) => {
            let mut map = serde_json::Map::new();
            for (k, v) in pairs {
                let key = match k {
                    redis::Value::BulkString(b) => String::from_utf8_lossy(&b).into_owned(),
                    redis::Value::SimpleString(s) => s,
                    other => format!("{:?}", other),
                };
                map.insert(key, redis_value_to_json(v));
            }
            Value::Object(map)
        }
        redis::Value::Boolean(b) => Value::Bool(b),
        redis::Value::Double(d) => serde_json::Number::from_f64(d)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        other => Value::String(format!("{:?}", other)),
    }
}

#[async_trait]
impl DbAdapter for RedisAdapter {
    fn type_name(&self) -> &'static str {
        "redis"
    }

    fn port_hint(&self) -> u16 {
        6379
    }

    async fn test_connection(&self, host: &str, port: u16, creds: &Credentials) -> crate::error::Result<()> {
        let url = make_url(host, port, creds, None);
        let client = redis::Client::open(url)
            .map_err(|e| crate::error::AppError::Redis(e.to_string()))?;
        let mut con = client
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| crate::error::AppError::Redis(e.to_string()))?;
        let _: redis::Value = redis::cmd("PING")
            .query_async(&mut con)
            .await
            .map_err(|e| crate::error::AppError::Redis(e.to_string()))?;
        Ok(())
    }

    async fn query(&self, host: &str, port: u16, creds: &Credentials, sql: &str) -> crate::error::Result<QueryResult> {
        let url = make_url(host, port, creds, None);
        let client = redis::Client::open(url)
            .map_err(|e| crate::error::AppError::Redis(e.to_string()))?;
        let mut con = client
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| crate::error::AppError::Redis(e.to_string()))?;

        let parts: Vec<&str> = sql.split_whitespace().collect();
        if parts.is_empty() {
            return Ok(QueryResult { columns: vec![], rows: vec![], row_count: 0 });
        }

        let mut cmd = redis::cmd(parts[0]);
        for arg in &parts[1..] {
            cmd.arg(*arg);
        }

        let raw = cmd.query_async(&mut con).await;

        // When GET is used on a non-string key, auto-dispatch to the right read command.
        let result: redis::Value = match raw {
            Err(ref e) if e.to_string().contains("WRONGTYPE")
                && parts[0].eq_ignore_ascii_case("GET")
                && parts.len() == 2 =>
            {
                let key = parts[1];
                let key_type: String = redis::cmd("TYPE")
                    .arg(key)
                    .query_async(&mut con)
                    .await
                    .unwrap_or_else(|_| "string".to_string());
                match key_type.as_str() {
                    "hash"   => redis::cmd("HGETALL").arg(key).query_async(&mut con).await,
                    "list"   => redis::cmd("LRANGE").arg(key).arg(0).arg(-1).query_async(&mut con).await,
                    "set"    => redis::cmd("SMEMBERS").arg(key).query_async(&mut con).await,
                    "zset"   => redis::cmd("ZRANGE").arg(key).arg(0).arg(-1).arg("WITHSCORES").query_async(&mut con).await,
                    "stream" => redis::cmd("XRANGE").arg(key).arg("-").arg("+").query_async(&mut con).await,
                    _        => raw,
                }.map_err(|e| crate::error::AppError::Redis(e.to_string()))?
            }
            other => other.map_err(|e| crate::error::AppError::Redis(e.to_string()))?,
        };

        match result {
            redis::Value::Array(arr) => {
                let rows: Vec<Vec<Value>> = arr
                    .into_iter()
                    .map(|v| vec![redis_value_to_json(v)])
                    .collect();
                let row_count = rows.len();
                Ok(QueryResult {
                    columns: vec!["value".into()],
                    rows,
                    row_count,
                })
            }
            redis::Value::Map(pairs) => {
                let mut keys: Vec<String> = Vec::new();
                let mut row: Vec<Value> = Vec::new();
                for (k, v) in pairs {
                    let key = match &k {
                        redis::Value::BulkString(b) => String::from_utf8_lossy(b).into_owned(),
                        redis::Value::SimpleString(s) => s.clone(),
                        other => format!("{:?}", other),
                    };
                    keys.push(key);
                    row.push(redis_value_to_json(v));
                }
                Ok(QueryResult {
                    columns: keys,
                    rows: vec![row],
                    row_count: 1,
                })
            }
            scalar => {
                let json_val = redis_value_to_json(scalar);
                Ok(QueryResult {
                    columns: vec!["value".into()],
                    rows: vec![vec![json_val]],
                    row_count: 1,
                })
            }
        }
    }

    async fn schema(&self, host: &str, port: u16, creds: &Credentials) -> crate::error::Result<Vec<SchemaNode>> {
        let url = make_url(host, port, creds, None);
        let client = redis::Client::open(url)
            .map_err(|e| crate::error::AppError::Redis(e.to_string()))?;
        let mut con = client
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| crate::error::AppError::Redis(e.to_string()))?;

        let total: i64 = redis::cmd("DBSIZE")
            .query_async(&mut con)
            .await
            .unwrap_or(0);

        // SCAN up to 500 keys
        let mut keys: Vec<String> = Vec::new();
        let mut cursor: u64 = 0;
        loop {
            let (next_cursor, batch): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("COUNT")
                .arg("200")
                .query_async(&mut con)
                .await
                .map_err(|e| crate::error::AppError::Redis(e.to_string()))?;
            keys.extend(batch);
            cursor = next_cursor;
            if cursor == 0 || keys.len() >= 500 {
                break;
            }
        }
        keys.sort();

        // Group by first ':' prefix
        use std::collections::BTreeMap;
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for key in &keys {
            let prefix = if let Some(pos) = key.find(':') {
                format!("{}:*", &key[..pos])
            } else {
                key.clone()
            };
            groups.entry(prefix).or_default().push(key.clone());
        }

        let mut table_nodes: Vec<SchemaNode> = Vec::new();
        for (prefix, group_keys) in groups {
            if group_keys.len() == 1 && prefix == group_keys[0] {
                // Individual key with no ':' prefix
                table_nodes.push(SchemaNode {
                    name: prefix,
                    kind: SchemaNodeKind::Table,
                    children: vec![],
                });
            } else if group_keys.len() == 1 {
                // Only one key in this prefix group — show as individual key
                table_nodes.push(SchemaNode {
                    name: group_keys[0].clone(),
                    kind: SchemaNodeKind::Table,
                    children: vec![],
                });
            } else {
                // Multiple keys under same prefix
                let children = group_keys
                    .iter()
                    .map(|k| SchemaNode {
                        name: k.clone(),
                        kind: SchemaNodeKind::Column,
                        children: vec![],
                    })
                    .collect();
                table_nodes.push(SchemaNode {
                    name: prefix,
                    kind: SchemaNodeKind::Table,
                    children,
                });
            }
        }

        let label = if (keys.len() as i64) < total {
            format!("db0 ({} keys, showing {})", total, keys.len())
        } else {
            format!("db0 ({} keys)", total)
        };

        Ok(vec![SchemaNode {
            name: label,
            kind: SchemaNodeKind::Database,
            children: table_nodes,
        }])
    }
}
