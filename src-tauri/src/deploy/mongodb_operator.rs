use super::operator::*;

const CRDS_URL: &str =
    "https://raw.githubusercontent.com/mongodb/mongodb-kubernetes/1.8.0/public/crds.yaml";
const OPERATOR_URL: &str =
    "https://raw.githubusercontent.com/mongodb/mongodb-kubernetes/1.8.0/public/mongodb-kubernetes.yaml";

pub struct MongoDbOperator;

impl DatabaseOperator for MongoDbOperator {
    fn info(&self) -> OperatorInfo {
        OperatorInfo {
            id: "mongodb-operator".into(),
            name: "MongoDB Community Operator".into(),
            db_type: "mongodb".into(),
            description: "MongoDB Community Kubernetes Operator (MCK)".into(),
            install_url: CRDS_URL.into(),
            install_cmd: format!(
                "kubectl apply --server-side -f {CRDS_URL} && kubectl apply --server-side -f {OPERATOR_URL}"
            ),
            docs_url: "https://www.mongodb.com/docs/kubernetes/current/".into(),
            remote_port: 27017,
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
             \x20 password: {pass_b64}\n",
            secret_name = secret_name,
            ns = p.namespace,
            pass_b64 = b64(&p.password),
        );

        let mdb = format!(
            "apiVersion: mongodbcommunity.mongodb.com/v1\n\
             kind: MongoDBCommunity\n\
             metadata:\n\
             \x20 name: {name}\n\
             \x20 namespace: {ns}\n\
             spec:\n\
             \x20 members: {instances}\n\
             \x20 type: ReplicaSet\n\
             \x20 version: \"7.0.0\"\n\
             \x20 security:\n\
             \x20   authentication:\n\
             \x20     modes:\n\
             \x20     - SCRAM\n\
             \x20 users:\n\
             \x20 - name: {user}\n\
             \x20   db: {database}\n\
             \x20   passwordSecretRef:\n\
             \x20     name: {secret_name}\n\
             \x20   roles:\n\
             \x20   - name: readWrite\n\
             \x20     db: {database}\n\
             \x20   - name: dbAdmin\n\
             \x20     db: {database}\n\
             \x20   scramCredentialsSecretName: {name}-scram\n",
            name = p.name,
            ns = p.namespace,
            instances = p.instances,
            user = yaml_str(&p.username),
            database = yaml_str(&p.database),
            secret_name = secret_name,
        );

        vec![
            (secret_name, secret),
            (p.name.clone(), mdb),
        ]
    }

    fn service_name(&self, p: &DeployParams) -> String {
        format!("{}-svc", p.name)
    }

    fn remote_port(&self) -> u16 {
        27017
    }

    fn resources_to_delete(&self, cr_name: &str, namespace: &str) -> Vec<(String, String, String)> {
        vec![
            ("mongodbcommunity".into(), cr_name.into(), namespace.into()),
            ("secret".into(), format!("{}-credentials", cr_name), namespace.into()),
        ]
    }

    fn crd_group(&self) -> &'static str {
        "mongodbcommunity.mongodb.com"
    }
}
