use async_trait::async_trait;
use futures_util::TryStreamExt;
use mongodb::{
    bson::{self, Bson, Document},
    options::FindOptions,
    Client,
};
use serde_json::Value;

use super::{Credentials, DbAdapter, QueryResult, SchemaNode, SchemaNodeKind};

pub struct MongoDbAdapter;

fn make_url(host: &str, port: u16, creds: &Credentials) -> String {
    if creds.user.is_empty() {
        format!("mongodb://{}:{}", host, port)
    } else {
        format!(
            "mongodb://{}:{}@{}:{}",
            creds.user, creds.password, host, port
        )
    }
}

fn bson_to_json(bson: Bson) -> Value {
    match bson {
        Bson::Double(d) => serde_json::Number::from_f64(d)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        Bson::String(s) => Value::String(s),
        Bson::Array(arr) => Value::Array(arr.into_iter().map(bson_to_json).collect()),
        Bson::Document(doc) => {
            let mut map = serde_json::Map::new();
            for (k, v) in doc {
                map.insert(k, bson_to_json(v));
            }
            Value::Object(map)
        }
        Bson::Boolean(b) => Value::Bool(b),
        Bson::Null => Value::Null,
        Bson::Int32(i) => Value::Number(i.into()),
        Bson::Int64(i) => Value::Number(i.into()),
        Bson::ObjectId(oid) => Value::String(oid.to_hex()),
        Bson::DateTime(dt) => Value::String(dt.to_string()),
        other => Value::String(format!("{}", other)),
    }
}

#[async_trait]
impl DbAdapter for MongoDbAdapter {
    fn type_name(&self) -> &'static str {
        "mongodb"
    }

    fn port_hint(&self) -> u16 {
        27017
    }

    async fn test_connection(&self, host: &str, port: u16, creds: &Credentials) -> crate::error::Result<()> {
        let url = make_url(host, port, creds);
        let client = Client::with_uri_str(&url)
            .await
            .map_err(|e| crate::error::AppError::Mongo(e.to_string()))?;
        // Ping by listing databases
        client
            .list_database_names()
            .await
            .map_err(|e| crate::error::AppError::Mongo(e.to_string()))?;
        Ok(())
    }

    async fn query(&self, host: &str, port: u16, creds: &Credentials, sql: &str) -> crate::error::Result<QueryResult> {
        let url = make_url(host, port, creds);
        let client = Client::with_uri_str(&url)
            .await
            .map_err(|e| crate::error::AppError::Mongo(e.to_string()))?;

        // Parse: first line = [db.]collection, remaining = JSON filter
        let mut lines = sql.splitn(2, '\n');
        let collection_spec = lines.next().unwrap_or("").trim();
        let filter_str = lines.next().unwrap_or("{}").trim();

        let (db_name, coll_name) = if let Some(dot) = collection_spec.find('.') {
            let (db, coll) = collection_spec.split_at(dot);
            (db.to_string(), coll[1..].to_string())
        } else {
            let db = creds.database.clone().unwrap_or_else(|| "test".into());
            (db, collection_spec.to_string())
        };

        let filter: Document = if filter_str.is_empty() || filter_str == "{}" {
            Document::new()
        } else {
            let json_val: serde_json::Value = serde_json::from_str(filter_str)
                .map_err(|e| crate::error::AppError::Mongo(format!("Invalid filter JSON: {}", e)))?;
            bson::to_document(&json_val)
                .map_err(|e| crate::error::AppError::Mongo(e.to_string()))?
        };

        let db = client.database(&db_name);
        let collection = db.collection::<Document>(&coll_name);

        let opts = FindOptions::builder().limit(1000i64).build();
        let mut cursor = collection
            .find(filter)
            .with_options(opts)
            .await
            .map_err(|e| crate::error::AppError::Mongo(e.to_string()))?;

        let mut col_set: indexmap::IndexSet<String> = indexmap::IndexSet::new();
        let mut doc_maps: Vec<std::collections::HashMap<String, Value>> = Vec::new();

        while let Some(doc) = cursor
            .try_next()
            .await
            .map_err(|e| crate::error::AppError::Mongo(e.to_string()))?
        {
            let mut row_map = std::collections::HashMap::new();
            for (k, v) in doc {
                col_set.insert(k.clone());
                row_map.insert(k, bson_to_json(v));
            }
            doc_maps.push(row_map);
        }

        let columns: Vec<String> = col_set.into_iter().collect();
        let rows: Vec<Vec<Value>> = doc_maps
            .into_iter()
            .map(|mut m| {
                columns
                    .iter()
                    .map(|col| m.remove(col).unwrap_or(Value::Null))
                    .collect()
            })
            .collect();

        let row_count = rows.len();
        Ok(QueryResult { columns, rows, row_count })
    }

    async fn schema(&self, host: &str, port: u16, creds: &Credentials) -> crate::error::Result<Vec<SchemaNode>> {
        let url = make_url(host, port, creds);
        let client = Client::with_uri_str(&url)
            .await
            .map_err(|e| crate::error::AppError::Mongo(e.to_string()))?;

        let db_names: Vec<String> = if let Some(ref db) = creds.database {
            vec![db.clone()]
        } else {
            client
                .list_database_names()
                .await
                .map_err(|e| crate::error::AppError::Mongo(e.to_string()))?
        };

        let mut result: Vec<SchemaNode> = Vec::new();

        for db_name in db_names {
            let db = client.database(&db_name);
            let collections = db
                .list_collection_names()
                .await
                .map_err(|e| crate::error::AppError::Mongo(e.to_string()))?;

            let children: Vec<SchemaNode> = collections
                .into_iter()
                .map(|coll_name| SchemaNode {
                    name: coll_name,
                    kind: SchemaNodeKind::Table,
                    children: vec![],
                })
                .collect();

            result.push(SchemaNode {
                name: db_name,
                kind: SchemaNodeKind::Database,
                children,
            });
        }

        Ok(result)
    }
}
