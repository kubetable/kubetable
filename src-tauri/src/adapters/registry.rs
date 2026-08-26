use super::{
    cassandra::CassandraAdapter,
    cockroachdb::CockroachDbAdapter,
    mongodb::MongoDbAdapter,
    mysql::MySqlAdapter,
    postgres::PostgresAdapter,
    redis::RedisAdapter,
    DbAdapter,
};

pub static ADAPTERS: &[&(dyn DbAdapter + Sync)] = &[
    &PostgresAdapter,
    &MySqlAdapter,
    &CockroachDbAdapter,
    &RedisAdapter,
    &MongoDbAdapter,
    &CassandraAdapter,
];

pub fn find_adapter(db_type: &str) -> Option<&'static (dyn DbAdapter + Sync)> {
    ADAPTERS.iter().copied().find(|a| a.type_name() == db_type)
}
