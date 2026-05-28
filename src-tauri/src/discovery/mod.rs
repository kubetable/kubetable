pub mod credentials;

use k8s_openapi::api::core::v1::Service;
use kube::{api::ListParams, Api, Client};
use serde::{Deserialize, Serialize};

use crate::adapters::registry::ADAPTERS;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredService {
    pub namespace: String,
    pub name: String,
    pub db_type: String,
    pub port: u16,
    pub credential_secret: Option<String>,
    pub operator_id: Option<String>,
    pub operator_resource_name: Option<String>,
}

pub async fn discover_services(client: &Client) -> crate::error::Result<Vec<DiscoveredService>> {
    let services: Api<Service> = Api::all(client.clone());
    let list = services.list(&ListParams::default()).await?;

    let mut found = Vec::new();

    for svc in list.items {
        let meta = &svc.metadata;
        let namespace = meta.namespace.clone().unwrap_or_default();
        let name = meta.name.clone().unwrap_or_default();
        let annotations = meta.annotations.as_ref();

        let labels = svc.metadata.labels.as_ref();

        let credential_secret = annotations
            .and_then(|a| a.get("kubedb.io/secret"))
            .cloned();

        // Detect operator-managed services by well-known labels
        let cnpg_cluster = labels.and_then(|l| l.get("cnpg.io/cluster")).cloned();
        let operator_id = cnpg_cluster.as_ref().map(|_| "cloudnativepg".to_string());
        let operator_resource_name = cnpg_cluster;

        // Check each port against the adapter registry
        if let Some(spec) = &svc.spec {
            for port_entry in spec.ports.iter().flatten() {
                let port = port_entry.port as u16;

                // Allow annotation override: kubedb.io/type=postgres
                let db_type = annotations
                    .and_then(|a| a.get("kubedb.io/type"))
                    .cloned()
                    .or_else(|| ADAPTERS.iter().find(|a| a.port_hint() == port).map(|a| a.type_name().to_string()));

                if let Some(db_type) = db_type {
                    found.push(DiscoveredService {
                        namespace,
                        name,
                        db_type,
                        port,
                        credential_secret,
                        operator_id: operator_id.clone(),
                        operator_resource_name: operator_resource_name.clone(),
                    });
                    break; // one entry per service
                }
            }
        }
    }

    Ok(found)
}

pub fn list_contexts() -> crate::error::Result<Vec<String>> {
    let kubeconfig = kube::config::Kubeconfig::read()?;
    let names = kubeconfig
        .contexts
        .iter()
        .map(|c| c.name.clone())
        .collect();
    Ok(names)
}

pub fn current_context() -> crate::error::Result<Option<String>> {
    let kubeconfig = kube::config::Kubeconfig::read()?;
    Ok(kubeconfig.current_context)
}
