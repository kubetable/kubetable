use super::operator::*;

const CRD_URL: &str =
    "https://raw.githubusercontent.com/spotahome/redis-operator/v1.2.4/manifests/databases.spotahome.com_redisfailovers.yaml";
const OPERATOR_URL: &str =
    "https://raw.githubusercontent.com/spotahome/redis-operator/v1.2.4/manifests/operator.yaml";

pub struct RedisOperator;

impl DatabaseOperator for RedisOperator {
    fn info(&self) -> OperatorInfo {
        OperatorInfo {
            id: "redis-operator".into(),
            name: "Redis Operator".into(),
            db_type: "redis".into(),
            description: "Spotahome Redis Operator for Kubernetes (Redis Failover)".into(),
            install_url: CRD_URL.into(),
            install_cmd: format!(
                "kubectl apply --server-side -f {CRD_URL} && kubectl apply --server-side -f {OPERATOR_URL}"
            ),
            docs_url: "https://github.com/spotahome/redis-operator".into(),
            remote_port: 6379,
        }
    }

    fn install_urls(&self) -> Vec<String> {
        vec![CRD_URL.into(), OPERATOR_URL.into()]
    }

    fn generate_manifests(&self, p: &DeployParams) -> Vec<(String, String)> {
        let secret_name = format!("{}-credentials", p.name);

        let secret = format!(
            "apiVersion: v1\n\
             kind: Secret\n\
             metadata:\n\
             \x20 name: {secret_name}\n\
             \x20 namespace: {ns}\n\
             type: Opaque\n\
             data:\n\
             \x20 password: {pass_b64}\n",
            secret_name = secret_name,
            ns = p.namespace,
            pass_b64 = b64(&p.password),
        );

        let failover = format!(
            "apiVersion: databases.spotahome.com/v1\n\
             kind: RedisFailover\n\
             metadata:\n\
             \x20 name: {name}\n\
             \x20 namespace: {ns}\n\
             spec:\n\
             \x20 sentinel:\n\
             \x20   replicas: 3\n\
             \x20 redis:\n\
             \x20   replicas: {instances}\n\
             \x20   storage:\n\
             \x20     persistentVolumeClaim:\n\
             \x20       metadata:\n\
             \x20         name: {name}-data\n\
             \x20       spec:\n\
             \x20         accessModes:\n\
             \x20         - ReadWriteOnce\n\
             \x20         resources:\n\
             \x20           requests:\n\
             \x20             storage: {storage}Gi\n\
             \x20 auth:\n\
             \x20   secretPath: {secret_name}\n",
            name = p.name,
            ns = p.namespace,
            instances = p.instances,
            secret_name = secret_name,
            storage = p.storage_gi,
        );

        vec![
            (secret_name, secret),
            (p.name.clone(), failover),
        ]
    }

    fn service_name(&self, p: &DeployParams) -> String {
        format!("rfr-{}", p.name)
    }

    fn remote_port(&self) -> u16 {
        6379
    }

    fn resources_to_delete(&self, cr_name: &str, namespace: &str) -> Vec<(String, String, String)> {
        vec![
            ("redisfailover".into(), cr_name.into(), namespace.into()),
            ("secret".into(), format!("{}-credentials", cr_name), namespace.into()),
        ]
    }

    fn crd_group(&self) -> &'static str {
        "databases.spotahome.com"
    }
}
