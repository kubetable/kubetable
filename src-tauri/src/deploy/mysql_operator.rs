use super::operator::*;

const CRDS_URL: &str =
    "https://raw.githubusercontent.com/mysql/mysql-operator/9.3.0-2.2.3/deploy/deploy-crds.yaml";
const OPERATOR_URL: &str =
    "https://raw.githubusercontent.com/mysql/mysql-operator/9.3.0-2.2.3/deploy/deploy-operator.yaml";

pub struct MySqlOperator;

impl DatabaseOperator for MySqlOperator {
    fn info(&self) -> OperatorInfo {
        OperatorInfo {
            id: "mysql-operator".into(),
            name: "MySQL Operator".into(),
            db_type: "mysql".into(),
            description: "Oracle MySQL Operator for Kubernetes (InnoDB Cluster)".into(),
            install_url: CRDS_URL.into(),
            install_cmd: format!(
                "kubectl apply --server-side -f {CRDS_URL} && kubectl apply --server-side -f {OPERATOR_URL}"
            ),
            docs_url: "https://dev.mysql.com/doc/mysql-operator/en/".into(),
            remote_port: 6446,
        }
    }

    fn install_urls(&self) -> Vec<String> {
        vec![CRDS_URL.into(), OPERATOR_URL.into()]
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
             \x20 rootUser: {user_b64}\n\
             \x20 rootHost: {host_b64}\n\
             \x20 rootPassword: {pass_b64}\n",
            secret_name = secret_name,
            ns = p.namespace,
            user_b64 = b64(&p.username),
            host_b64 = b64("%"),
            pass_b64 = b64(&p.password),
        );

        let cluster = format!(
            "apiVersion: mysql.oracle.com/v2\n\
             kind: InnoDBCluster\n\
             metadata:\n\
             \x20 name: {name}\n\
             \x20 namespace: {ns}\n\
             spec:\n\
             \x20 secretName: {secret_name}\n\
             \x20 defaultUserHost: '%'\n\
             \x20 tlsUseSelfSigned: true\n\
             \x20 instances: {instances}\n\
             \x20 router:\n\
             \x20   instances: 1\n\
             \x20 datadirVolumeClaimTemplate:\n\
             \x20   accessModes:\n\
             \x20   - ReadWriteOnce\n\
             \x20   resources:\n\
             \x20     requests:\n\
             \x20       storage: {storage}Gi\n",
            name = p.name,
            ns = p.namespace,
            instances = p.instances,
            secret_name = secret_name,
            storage = p.storage_gi,
        );

        vec![
            (secret_name, secret),
            (p.name.clone(), cluster),
        ]
    }

    fn service_name(&self, p: &DeployParams) -> String {
        p.name.clone()
    }

    fn remote_port(&self) -> u16 {
        6446
    }

    fn resources_to_delete(&self, cr_name: &str, namespace: &str) -> Vec<(String, String, String)> {
        vec![
            ("innodbcluster".into(), cr_name.into(), namespace.into()),
            ("secret".into(), format!("{}-credentials", cr_name), namespace.into()),
        ]
    }

    fn crd_group(&self) -> &'static str {
        "mysql.oracle.com"
    }
}
