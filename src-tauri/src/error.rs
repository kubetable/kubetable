use std::error::Error as StdError;

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Kubernetes error: {0}")]
    Kube(#[from] kube::Error),

    #[error("Kubernetes config error: {0}")]
    KubeConfig(#[from] kube::config::KubeconfigError),

    #[error("Kubernetes infer config error: {0}")]
    KubeInfer(#[from] kube::config::InferConfigError),

    #[error("Postgres error: {0}")]
    Postgres(#[from] tokio_postgres::Error),

    #[error("MySQL error: {0}")]
    MySql(String),

    #[error("Redis error: {0}")]
    Redis(String),

    #[error("MongoDB error: {0}")]
    Mongo(String),

    #[error("Cassandra error: {0}")]
    Cassandra(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Port-forward error: {0}")]
    PortForward(String),

    #[error("{0}")]
    Other(String),
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

fn full_message(err: &dyn StdError) -> String {
    let mut parts = vec![err.to_string()];
    let mut src = err.source();
    while let Some(cause) = src {
        let msg = cause.to_string();
        if !parts.contains(&msg) {
            parts.push(msg);
        }
        src = cause.source();
    }
    parts.join(": ")
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let msg = match self {
            AppError::Postgres(e) => {
                if let Some(db) = e.as_db_error() {
                    // PG protocol error — show message + hint if present
                    let mut out = format!("Postgres: {}", db.message());
                    if let Some(detail) = db.detail() {
                        out.push_str(&format!("\nDetail: {detail}"));
                    }
                    if let Some(hint) = db.hint() {
                        out.push_str(&format!("\nHint: {hint}"));
                    }
                    out
                } else {
                    // Transport / IO error — show full cause chain
                    format!("Connection error: {}", full_message(e))
                }
            }
            AppError::PortForward(msg) => format!("Port-forward failed: {msg}"),
            AppError::Kube(e) => format!("Kubernetes error: {}", full_message(e)),
            AppError::Io(e) => format!("IO error: {}", full_message(e)),
            other => other.to_string(),
        };
        s.serialize_str(&msg)
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
