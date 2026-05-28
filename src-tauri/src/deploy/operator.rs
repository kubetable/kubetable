use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployParams {
    pub operator_id: String,
    pub namespace: String,
    pub name: String,
    pub instances: u8,
    pub pg_version: u8,
    pub storage_gi: u8,
    pub database: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DeployPhase {
    Applying,
    Initializing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployStatus {
    pub phase: DeployPhase,
    pub message: String,
    pub service_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperatorInfo {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub description: String,
    pub install_cmd: String,
    pub install_url: String,
    pub docs_url: String,
    pub remote_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticCheck {
    pub id: String,
    pub label: String,
    pub status: CheckStatus,
    pub detail: String,
    pub fix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Pass,
    Fail,
    Warn,
}

pub trait DatabaseOperator: Send + Sync {
    fn info(&self) -> OperatorInfo;
    fn generate_manifests(&self, params: &DeployParams) -> Vec<(String, String)>;
    fn service_name(&self, params: &DeployParams) -> String;
    fn remote_port(&self) -> u16;
    fn resources_to_delete(&self, cr_name: &str, namespace: &str) -> Vec<(String, String, String)>;
    fn crd_group(&self) -> &'static str;
    fn install_urls(&self) -> Vec<String> {
        vec![self.info().install_url.clone()]
    }
}

/// Base64-encode a string for use in a Kubernetes Secret `data:` field.
pub fn b64(s: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.encode(s)
}

/// Wrap a string in YAML single quotes, escaping any internal single quotes.
/// Use for user-controlled values that appear inline in non-secret YAML fields.
pub fn yaml_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

pub fn list_operators() -> Vec<OperatorInfo> {
    vec![
        super::cloudnativepg::CloudNativePGOperator.info(),
        super::mysql_operator::MySqlOperator.info(),
        super::redis_operator::RedisOperator.info(),
        super::mongodb_operator::MongoDbOperator.info(),
    ]
}

pub fn find_operator(id: &str) -> Option<Box<dyn DatabaseOperator>> {
    match id {
        "cloudnativepg" => Some(Box::new(super::cloudnativepg::CloudNativePGOperator)),
        "mysql-operator" => Some(Box::new(super::mysql_operator::MySqlOperator)),
        "redis-operator" => Some(Box::new(super::redis_operator::RedisOperator)),
        "mongodb-operator" => Some(Box::new(super::mongodb_operator::MongoDbOperator)),
        _ => None,
    }
}
