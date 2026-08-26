use std::collections::HashMap;

use k8s_openapi::api::core::v1::{ConfigMap, Pod, Secret, Service};
use kube::{api::ListParams, Api, Client};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DetectedCredentials {
    pub user: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    pub source: String,
}

pub async fn detect_credentials(
    client: &Client,
    namespace: &str,
    service_name: &str,
    db_type: &str,
) -> crate::error::Result<DetectedCredentials> {
    match db_type {
        "redis" => detect_redis(client, namespace, service_name).await,
        "mysql" => detect_mysql(client, namespace, service_name).await,
        "mongodb" => detect_mongo(client, namespace, service_name).await,
        "cassandra" => detect_cassandra(client, namespace, service_name).await,
        _ => detect_postgres(client, namespace, service_name).await,
    }
}

async fn detect_redis(
    client: &Client,
    namespace: &str,
    service_name: &str,
) -> crate::error::Result<DetectedCredentials> {
    let secret_api: Api<Secret> = Api::namespaced(client.clone(), namespace);

    // Common Redis secret naming patterns — try each until one has a password.
    let base = service_name
        .strip_prefix("rfr-")   // Spotahome redis node service prefix
        .or_else(|| service_name.strip_prefix("rfs-"))
        .unwrap_or(service_name);

    let candidates = [
        format!("{base}-credentials"),
        format!("{base}-auth"),
        format!("{base}"),
        format!("{service_name}-credentials"),
    ];
    // Password key names Redis operators commonly use.
    let pw_keys = ["password", "redis-password", "REDIS_PASSWORD", "requirepass"];

    for name in &candidates {
        if let Ok(secret) = secret_api.get(name).await {
            let data = secret.data.unwrap_or_default();
            for key in &pw_keys {
                if let Some(v) = data.get(*key) {
                    return Ok(DetectedCredentials {
                        user: None,
                        password: Some(decode_bytes(&v.0)),
                        database: None,
                        source: format!("Secret/{name}"),
                    });
                }
            }
        }
    }

    // Fall back to pod env vars.
    let env = collect_pod_env(client, namespace, service_name).await;
    let password = env
        .get("REDIS_PASSWORD")
        .or_else(|| env.get("REDIS_AUTH"))
        .or_else(|| env.get("REQUIREPASS"))
        .cloned();

    let source = if password.is_some() { "pod env".into() } else { "No Redis credentials found".into() };
    Ok(DetectedCredentials { user: None, password, database: None, source })
}

async fn detect_mysql(
    client: &Client,
    namespace: &str,
    service_name: &str,
) -> crate::error::Result<DetectedCredentials> {
    let secret_api: Api<Secret> = Api::namespaced(client.clone(), namespace);

    // Oracle MySQL Operator stores root creds in a Secret with rootUser/rootPassword.
    // Also try {name}-credentials pattern.
    let base = service_name
        .strip_suffix("-instances")
        .unwrap_or(service_name);

    let candidates = [
        format!("{base}-credentials"),
        format!("{service_name}-credentials"),
        format!("{base}"),
    ];

    for name in &candidates {
        if let Ok(secret) = secret_api.get(name).await {
            let data = secret.data.unwrap_or_default();
            let user = data.get("rootUser")
                .or_else(|| data.get("username"))
                .or_else(|| data.get("MYSQL_USER"))
                .map(|v| decode_bytes(&v.0));
            let password = data.get("rootPassword")
                .or_else(|| data.get("password"))
                .or_else(|| data.get("MYSQL_PASSWORD"))
                .or_else(|| data.get("MYSQL_ROOT_PASSWORD"))
                .map(|v| decode_bytes(&v.0));
            if user.is_some() || password.is_some() {
                let database = data.get("database")
                    .or_else(|| data.get("MYSQL_DATABASE"))
                    .map(|v| decode_bytes(&v.0));
                return Ok(DetectedCredentials {
                    user, password, database,
                    source: format!("Secret/{name}"),
                });
            }
        }
    }

    // Pod env fallback.
    let env = collect_pod_env(client, namespace, service_name).await;
    let user = env.get("MYSQL_USER").cloned();
    let password = env.get("MYSQL_PASSWORD")
        .or_else(|| env.get("MYSQL_ROOT_PASSWORD"))
        .cloned();
    let database = env.get("MYSQL_DATABASE").cloned();
    let source = if user.is_some() || password.is_some() {
        "pod env".into()
    } else {
        "No MySQL credentials found".into()
    };
    Ok(DetectedCredentials { user, password, database, source })
}

async fn detect_mongo(
    client: &Client,
    namespace: &str,
    service_name: &str,
) -> crate::error::Result<DetectedCredentials> {
    let secret_api: Api<Secret> = Api::namespaced(client.clone(), namespace);

    let base = service_name.strip_suffix("-svc").unwrap_or(service_name);
    let candidates = [
        format!("{base}-credentials"),
        format!("{service_name}-credentials"),
    ];

    for name in &candidates {
        if let Ok(secret) = secret_api.get(name).await {
            let data = secret.data.unwrap_or_default();
            let user = data.get("username")
                .or_else(|| data.get("MONGO_INITDB_ROOT_USERNAME"))
                .map(|v| decode_bytes(&v.0));
            let password = data.get("password")
                .or_else(|| data.get("MONGO_INITDB_ROOT_PASSWORD"))
                .map(|v| decode_bytes(&v.0));
            if user.is_some() || password.is_some() {
                let database = data.get("database").map(|v| decode_bytes(&v.0));
                return Ok(DetectedCredentials {
                    user, password, database,
                    source: format!("Secret/{name}"),
                });
            }
        }
    }

    let env = collect_pod_env(client, namespace, service_name).await;
    let user = env.get("MONGO_INITDB_ROOT_USERNAME")
        .or_else(|| env.get("MONGODB_USERNAME"))
        .cloned();
    let password = env.get("MONGO_INITDB_ROOT_PASSWORD")
        .or_else(|| env.get("MONGODB_PASSWORD"))
        .cloned();
    let database = env.get("MONGO_INITDB_DATABASE")
        .or_else(|| env.get("MONGODB_DATABASE"))
        .cloned();
    let source = if user.is_some() || password.is_some() {
        "pod env".into()
    } else {
        "No MongoDB credentials found".into()
    };
    Ok(DetectedCredentials { user, password, database, source })
}

async fn detect_postgres(
    client: &Client,
    namespace: &str,
    service_name: &str,
) -> crate::error::Result<DetectedCredentials> {
    let svc_api: Api<Service> = Api::namespaced(client.clone(), namespace);
    let svc = svc_api.get(service_name).await?;

    // CloudNativePG / suffix-stripped secret check.
    {
        let secret_api: Api<Secret> = Api::namespaced(client.clone(), namespace);
        let cnp_cluster = svc.metadata.labels.as_ref()
            .and_then(|l| l.get("cnpg.io/cluster"))
            .cloned();
        let candidates: Vec<String> = if let Some(ref cluster) = cnp_cluster {
            vec![format!("{}-credentials", cluster)]
        } else {
            let base = service_name
                .strip_suffix("-rw")
                .or_else(|| service_name.strip_suffix("-ro"))
                .or_else(|| service_name.strip_suffix("-r"))
                .unwrap_or(service_name);
            if base != service_name { vec![format!("{}-credentials", base)] } else { vec![] }
        };
        for secret_name in candidates {
            if let Ok(secret) = secret_api.get(&secret_name).await {
                let data = secret.data.unwrap_or_default();
                let user = data.get("username").map(|v| decode_bytes(&v.0));
                let password = data.get("password").map(|v| decode_bytes(&v.0));
                if user.is_some() || password.is_some() {
                    let database = data.get("database")
                        .or_else(|| data.get("dbname"))
                        .map(|v| decode_bytes(&v.0));
                    return Ok(DetectedCredentials {
                        user, password, database,
                        source: format!("Secret/{}", secret_name),
                    });
                }
            }
        }
    }

    let selector = svc.spec.as_ref()
        .and_then(|s| s.selector.as_ref())
        .cloned()
        .unwrap_or_default();

    if selector.is_empty() {
        return Ok(DetectedCredentials {
            source: "No pod selector on service".into(),
            ..Default::default()
        });
    }

    let env = collect_pod_env(client, namespace, service_name).await;

    if let Some(url) = env.get("DATABASE_URL") {
        if let Some(creds) = parse_database_url(url) {
            return Ok(DetectedCredentials {
                source: "DATABASE_URL".into(),
                ..creds
            });
        }
    }

    let user = env.get("POSTGRES_USER").or_else(|| env.get("PGUSER"))
        .or_else(|| env.get("DB_USER")).cloned();
    let password = env.get("POSTGRES_PASSWORD").or_else(|| env.get("PGPASSWORD"))
        .or_else(|| env.get("DB_PASSWORD")).cloned();
    let database = env.get("POSTGRES_DB").or_else(|| env.get("PGDATABASE"))
        .or_else(|| env.get("DB_NAME")).cloned();

    let source = if user.is_some() || password.is_some() {
        "pod env".into()
    } else {
        "No credentials found in pod env".into()
    };

    Ok(DetectedCredentials { user, password, database, source })
}

async fn collect_pod_env(client: &Client, namespace: &str, service_name: &str) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = HashMap::new();

    let svc_api: Api<Service> = Api::namespaced(client.clone(), namespace);
    let selector = svc_api.get(service_name).await.ok()
        .and_then(|svc| svc.spec)
        .and_then(|s| s.selector)
        .unwrap_or_default();
    if selector.is_empty() { return env; }

    let label_selector = selector.iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>().join(",");

    let pod_api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pods = match pod_api.list(&ListParams::default().labels(&label_selector)).await {
        Ok(p) => p,
        Err(_) => return env,
    };
    let pod = match pods.items.first() {
        Some(p) => p,
        None => return env,
    };

    let secret_api: Api<Secret> = Api::namespaced(client.clone(), namespace);
    let cm_api: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);

    for container in pod.spec.iter().flat_map(|s| s.containers.iter()) {
        for env_from in container.env_from.iter().flatten() {
            if let Some(r) = &env_from.secret_ref {
                if let Ok(secret) = secret_api.get(&r.name).await {
                    for (k, v) in secret.data.iter().flatten() {
                        env.entry(k.clone()).or_insert_with(|| decode_bytes(&v.0));
                    }
                }
            }
            if let Some(r) = &env_from.config_map_ref {
                if let Ok(cm) = cm_api.get(&r.name).await {
                    for (k, v) in cm.data.iter().flatten() {
                        env.entry(k.clone()).or_insert_with(|| v.clone());
                    }
                }
            }
        }
        for ev in container.env.iter().flatten() {
            if let Some(val) = &ev.value {
                env.entry(ev.name.clone()).or_insert_with(|| val.clone());
            } else if let Some(vf) = &ev.value_from {
                if let Some(skr) = &vf.secret_key_ref {
                    if let Ok(secret) = secret_api.get(&skr.name).await {
                        if let Some(val) = secret.data.as_ref().and_then(|d| d.get(&skr.key)) {
                            env.entry(ev.name.clone()).or_insert_with(|| decode_bytes(&val.0));
                        }
                    }
                }
                if let Some(cmkr) = &vf.config_map_key_ref {
                    if let Ok(cm) = cm_api.get(&cmkr.name).await {
                        if let Some(val) = cm.data.as_ref().and_then(|d| d.get(&cmkr.key)) {
                            env.entry(ev.name.clone()).or_insert_with(|| val.clone());
                        }
                    }
                }
            }
        }
    }
    env
}

async fn detect_cassandra(
    client: &Client,
    namespace: &str,
    service_name: &str,
) -> crate::error::Result<DetectedCredentials> {
    let secret_api: Api<Secret> = Api::namespaced(client.clone(), namespace);

    let base = service_name
        .strip_suffix("-service")
        .or_else(|| service_name.strip_suffix("-svc"))
        .unwrap_or(service_name);

    // k8ssandra operator stores the cluster name in a label on the service.
    // The superuser secret is named {cluster-name}-superuser, which may differ
    // from the service name when services include a region suffix (e.g. -us-east-2).
    // cass-operator uses cassandra.datastax.com/cluster; k8ssandra uses k8ssandra.io/cluster-name.
    let svc_api: Api<Service> = Api::namespaced(client.clone(), namespace);
    let k8ssandra_cluster = svc_api.get(service_name).await.ok()
        .and_then(|svc| svc.metadata.labels)
        .and_then(|labels| {
            labels.get("k8ssandra.io/cluster-name")
                .or_else(|| labels.get("cassandra.datastax.com/cluster"))
                .cloned()
        });

    let mut candidates: Vec<String> = Vec::new();

    // k8ssandra superuser secret pattern: {cluster-name}-superuser
    if let Some(ref cluster) = k8ssandra_cluster {
        candidates.push(format!("{cluster}-superuser"));
        candidates.push(format!("{cluster}-credentials"));
    }

    candidates.push(format!("{base}-superuser"));
    candidates.push(format!("{base}-credentials"));
    candidates.push(format!("{service_name}-credentials"));
    candidates.push(base.to_string());

    let user_keys = ["username", "CASSANDRA_USER", "user"];
    let pw_keys = ["password", "CASSANDRA_PASSWORD", "CASSANDRA_PASS"];

    for name in &candidates {
        if let Ok(secret) = secret_api.get(name).await {
            let data = secret.data.unwrap_or_default();
            let user = user_keys.iter().find_map(|k| data.get(*k)).map(|v| decode_bytes(&v.0));
            let password = pw_keys.iter().find_map(|k| data.get(*k)).map(|v| decode_bytes(&v.0));
            if user.is_some() || password.is_some() {
                let database = data.get("keyspace").map(|v| decode_bytes(&v.0));
                return Ok(DetectedCredentials {
                    user,
                    password,
                    database,
                    source: format!("Secret/{name}"),
                });
            }
        }
    }

    let env = collect_pod_env(client, namespace, service_name).await;
    let user = env.get("CASSANDRA_USER").cloned();
    let password = env.get("CASSANDRA_PASSWORD")
        .or_else(|| env.get("CASSANDRA_PASS"))
        .cloned();
    let database = env.get("CASSANDRA_KEYSPACE").cloned();
    let source = if user.is_some() || password.is_some() {
        "pod env".into()
    } else {
        "No Cassandra credentials found".into()
    };
    Ok(DetectedCredentials { user, password, database, source })
}

fn decode_bytes(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn parse_database_url(url: &str) -> Option<DetectedCredentials> {
    let without_scheme = url
        .strip_prefix("postgresql://")
        .or_else(|| url.strip_prefix("postgres://"))?;
    let (userinfo, rest) = without_scheme.split_once('@')?;
    let (user, password) = userinfo.split_once(':').unwrap_or((userinfo, ""));
    let database = rest.split_once('/').map(|(_, db)| db.split('?').next().unwrap_or(db));
    Some(DetectedCredentials {
        user: Some(user.to_string()),
        password: if password.is_empty() { None } else { Some(password.to_string()) },
        database: database.map(str::to_string),
        source: String::new(),
    })
}
