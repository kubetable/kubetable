use super::operator::*;

pub struct CloudNativePGOperator;

impl DatabaseOperator for CloudNativePGOperator {
    fn info(&self) -> OperatorInfo {
        OperatorInfo {
            id: "cloudnativepg".into(),
            name: "CloudNativePG".into(),
            db_type: "postgres".into(),
            description: "Production-grade PostgreSQL operator for Kubernetes".into(),
            install_url: "https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.29/releases/cnpg-1.29.1.yaml".into(),
            install_cmd: "kubectl apply --server-side -f \
                https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.29/releases/cnpg-1.29.1.yaml"
                .into(),
            docs_url: "https://cloudnative-pg.io/documentation/current/installation_upgrade/".into(),
            remote_port: 5432,
        }
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
             \x20 username: {user_b64}\n\
             \x20 password: {pass_b64}\n",
            secret_name = secret_name,
            ns = p.namespace,
            user_b64 = b64(&p.username),
            pass_b64 = b64(&p.password),
        );

        let cluster = format!(
            "apiVersion: postgresql.cnpg.io/v1\n\
             kind: Cluster\n\
             metadata:\n\
             \x20 name: {name}\n\
             \x20 namespace: {ns}\n\
             spec:\n\
             \x20 instances: {instances}\n\
             \x20 imageName: ghcr.io/cloudnative-pg/postgresql:{pg_ver}\n\
             \x20 postgresql:\n\
             \x20   parameters: {{}}\n\
             \x20 bootstrap:\n\
             \x20   initdb:\n\
             \x20     database: {database}\n\
             \x20     owner: {user}\n\
             \x20     secret:\n\
             \x20       name: {secret_name}\n\
             \x20 storage:\n\
             \x20   size: {storage}Gi\n",
            name = p.name,
            ns = p.namespace,
            instances = p.instances,
            pg_ver = p.pg_version,
            database = yaml_str(&p.database),
            user = yaml_str(&p.username),
            secret_name = secret_name,
            storage = p.storage_gi,
        );

        vec![
            (secret_name, secret),
            (p.name.clone(), cluster),
        ]
    }

    fn service_name(&self, p: &DeployParams) -> String {
        // CloudNativePG exposes a read-write service as <cluster>-rw
        format!("{}-rw", p.name)
    }

    fn remote_port(&self) -> u16 {
        5432
    }

    fn resources_to_delete(&self, cr_name: &str, namespace: &str) -> Vec<(String, String, String)> {
        vec![
            ("cluster".into(), cr_name.into(), namespace.into()),
            ("secret".into(), format!("{}-credentials", cr_name), namespace.into()),
        ]
    }

    fn crd_group(&self) -> &'static str {
        "postgresql.cnpg.io"
    }
}
