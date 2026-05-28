use std::error::Error as StdError;

use tauri::State;
use tokio::time::{sleep, timeout, Duration};
use tracing::{debug, info, warn};

use crate::{
    adapters::{registry::find_adapter, Credentials, QueryResult, SchemaNode},
    cluster_store::{ClusterSource, ClusterSourceInfo, ClusterStore},
    deploy::{
        self, operator::find_operator as find_db_operator, DeployParams, DeployPhase, DeployStatus,
        DiagnosticCheck, CheckStatus, OperatorInfo,
    },
    discovery::{self, credentials::DetectedCredentials, DiscoveredService},
    error::AppError,
    portforward::{PortForwardManager, TunnelKey},
};

pub struct AppState {
    pub pfm: PortForwardManager,
    pub store: ClusterStore,
}

// IO/tunnel glitches — retry fast (3×, 800 ms).
// E28P01 is included: a broken tunnel can garble the startup message and
// produce a spurious "invalid password" that clears after one retry.
fn is_fast_transient(err: &AppError) -> bool {
    match err {
        AppError::Postgres(e) => {
            if let Some(db_err) = e.as_db_error() {
                return db_err.code().code() == "28P01"; // invalid_password
            }
            e.is_closed()
                || e.source()
                    .and_then(|s| s.downcast_ref::<std::io::Error>())
                    .is_some()
        }
        AppError::Io(_) => true,
        _ => false,
    }
}

// Operator-init errors — retry slowly (30×, 2 s ≈ 60 s total).
// PostgreSQL operators (CloudNativePG, etc.) create roles/databases
// asynchronously after the pod starts; E28000/E3D000 are expected
// during that window and resolve on their own.
fn is_slow_transient(err: &AppError) -> bool {
    match err {
        AppError::Postgres(e) => {
            if let Some(db_err) = e.as_db_error() {
                let code = db_err.code().code();
                return code == "28000"  // invalid_authorization_specification (role not yet created)
                    || code == "3D000"; // invalid_catalog_name (database not yet created)
            }
            false
        }
        _ => false,
    }
}

#[tauri::command]
pub fn list_cluster_sources(state: State<'_, AppState>) -> Vec<ClusterSourceInfo> {
    state.store.list_sources_with_contexts()
}

#[tauri::command]
pub fn add_cluster_file(state: State<'_, AppState>, path: String) -> Result<ClusterSource, AppError> {
    state.store.add_file(path)
}

#[tauri::command]
pub fn add_cluster_yaml(
    state: State<'_, AppState>,
    label: String,
    yaml: String,
) -> Result<ClusterSource, AppError> {
    state.store.add_yaml(label, yaml)
}

#[tauri::command]
pub fn remove_cluster_source(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.store.remove_source(&id)
}

#[tauri::command]
pub fn list_contexts(_state: State<'_, AppState>) -> Result<Vec<String>, AppError> {
    discovery::list_contexts()
}

#[tauri::command]
pub fn current_context(_state: State<'_, AppState>) -> Result<Option<String>, AppError> {
    discovery::current_context()
}

#[tauri::command]
pub async fn list_namespaces(
    state: State<'_, AppState>,
    source_id: String,
    context: Option<String>,
) -> Result<Vec<String>, AppError> {
    use k8s_openapi::api::core::v1::Namespace;
    use kube::{api::ListParams, Api};

    let client = state.store.build_client(&source_id, context.as_deref()).await?;
    let api: Api<Namespace> = Api::all(client);
    let list = api.list(&ListParams::default()).await?;
    let mut names: Vec<String> = list.items
        .into_iter()
        .filter_map(|n| n.metadata.name)
        .collect();
    names.sort();
    Ok(names)
}

#[tauri::command]
pub async fn discover_services(
    state: State<'_, AppState>,
    source_id: String,
    context: Option<String>,
) -> Result<Vec<DiscoveredService>, AppError> {
    let client = state.store.build_client(&source_id, context.as_deref()).await?;
    discovery::discover_services(&client).await
}

#[tauri::command]
pub async fn resolve_credentials(
    state: State<'_, AppState>,
    source_id: String,
    context: Option<String>,
    namespace: String,
    service: String,
    db_type: Option<String>,
) -> Result<DetectedCredentials, AppError> {
    let client = state.store.build_client(&source_id, context.as_deref()).await?;
    let db = db_type.as_deref().unwrap_or("postgres");
    discovery::credentials::detect_credentials(&client, &namespace, &service, db).await
}

#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    source_id: String,
    context: Option<String>,
    namespace: String,
    service: String,
    remote_port: u16,
    db_type: String,
    creds: Credentials,
) -> Result<u16, AppError> {
    info!("connect: {}/{} ({})", namespace, service, db_type);
    let key = build_tunnel_key(&state, &source_id, context.as_deref(), namespace, service, remote_port);
    let mut local_port = state.pfm.ensure_tunnel(&key)?;
    info!("connect: tunnel ready on local port {}", local_port);

    let adapter = find_adapter(&db_type)
        .ok_or_else(|| AppError::Other(format!("No adapter for db type: {}", db_type)))?;

    let mut fast_attempts = 0u8;
    let mut slow_attempts = 0u8;

    loop {
        debug!("connect: test_connection (fast={} slow={}) user={} db={:?}",
            fast_attempts, slow_attempts, creds.user, creds.database);
        let conn_result = timeout(
            Duration::from_secs(8),
            adapter.test_connection("127.0.0.1", local_port, &creds),
        ).await;
        match conn_result {
            Ok(Ok(())) => {
                info!("connect: success (fast={} slow={})", fast_attempts, slow_attempts);
                return Ok(local_port);
            }
            Ok(Err(e)) if is_slow_transient(&e) => {
                slow_attempts += 1;
                if slow_attempts >= 60 {
                    warn!("connect: DB init timeout after {}×1s — {}", slow_attempts, e);
                    return Err(e);
                }
                info!("connect: DB not ready yet (attempt {}/60), waiting 1s — {}", slow_attempts, e);
                sleep(Duration::from_secs(1)).await;
                local_port = state.pfm.ensure_tunnel(&key)?;
            }
            Ok(Err(e)) if is_fast_transient(&e) => {
                fast_attempts += 1;
                if fast_attempts >= 3 {
                    warn!("connect: fast-transient exhausted after {} attempts — {}", fast_attempts, e);
                    return Err(e);
                }
                warn!("connect: fast-transient attempt {}: {} — retrying in 800ms", fast_attempts, e);
                sleep(Duration::from_millis(800)).await;
                local_port = state.pfm.ensure_tunnel(&key)?;
            }
            Ok(Err(e)) => {
                warn!("connect: non-transient error: {}", e);
                return Err(e);
            }
            Err(_elapsed) => {
                slow_attempts += 1;
                if slow_attempts >= 60 {
                    warn!("connect: timed out waiting for DB after {} attempts", slow_attempts);
                    return Err(AppError::Other("Connection timed out".into()));
                }
                warn!("connect: test_connection timed out (attempt {}/60), retrying in 1s", slow_attempts);
                sleep(Duration::from_secs(1)).await;
                local_port = state.pfm.ensure_tunnel(&key)?;
            }
        }
    }
}

#[tauri::command]
pub fn disconnect(
    state: State<'_, AppState>,
    source_id: String,
    context: Option<String>,
    namespace: String,
    service: String,
    remote_port: u16,
) {
    let key = build_tunnel_key(&state, &source_id, context.as_deref(), namespace, service, remote_port);
    state.pfm.close_tunnel(&key);
}

#[tauri::command]
pub fn active_tunnels(state: State<'_, AppState>) -> Vec<(TunnelKey, u16)> {
    state.pfm.active_tunnels()
}

#[tauri::command]
pub async fn run_query(
    state: State<'_, AppState>,
    source_id: String,
    context: Option<String>,
    namespace: String,
    service: String,
    remote_port: u16,
    db_type: String,
    creds: Credentials,
    sql: String,
) -> Result<QueryResult, AppError> {
    let key = build_tunnel_key(&state, &source_id, context.as_deref(), namespace.clone(), service.clone(), remote_port);

    let adapter = find_adapter(&db_type)
        .ok_or_else(|| AppError::Other(format!("No adapter for db type: {}", db_type)))?;

    let mut last_err = AppError::Other("query failed".into());
    for attempt in 0u8..4 {
        if attempt > 0 { sleep(Duration::from_millis(500)).await; }
        let local_port = state.pfm.ensure_tunnel(&key)?;
        match adapter.query("127.0.0.1", local_port, &creds, &sql).await {
            Ok(r) => return Ok(r),
            Err(e) if is_fast_transient(&e) || is_slow_transient(&e) => { last_err = e; }
            Err(e) => return Err(e),
        }
    }
    Err(last_err)
}

#[tauri::command]
pub async fn explain_query(
    state: State<'_, AppState>,
    source_id: String,
    context: Option<String>,
    namespace: String,
    service: String,
    remote_port: u16,
    db_type: String,
    creds: Credentials,
    sql: String,
) -> Result<QueryResult, AppError> {
    let explain_sql = format!("EXPLAIN ANALYZE {}", sql.trim_end_matches(';'));
    let key = build_tunnel_key(&state, &source_id, context.as_deref(), namespace.clone(), service.clone(), remote_port);

    let adapter = find_adapter(&db_type)
        .ok_or_else(|| AppError::Other(format!("No adapter for db type: {}", db_type)))?;

    let mut last_err = AppError::Other("explain query failed".into());
    for attempt in 0u8..4 {
        if attempt > 0 { sleep(Duration::from_millis(500)).await; }
        let local_port = state.pfm.ensure_tunnel(&key)?;
        match adapter.query("127.0.0.1", local_port, &creds, &explain_sql).await {
            Ok(r) => return Ok(r),
            Err(e) if is_fast_transient(&e) || is_slow_transient(&e) => { last_err = e; }
            Err(e) => return Err(e),
        }
    }
    Err(last_err)
}

#[tauri::command]
pub async fn get_schema(
    state: State<'_, AppState>,
    source_id: String,
    context: Option<String>,
    namespace: String,
    service: String,
    remote_port: u16,
    db_type: String,
    creds: Credentials,
) -> Result<Vec<SchemaNode>, AppError> {
    let key = build_tunnel_key(&state, &source_id, context.as_deref(), namespace.clone(), service.clone(), remote_port);

    let adapter = find_adapter(&db_type)
        .ok_or_else(|| AppError::Other(format!("No adapter for db type: {}", db_type)))?;

    let mut last_err = AppError::Other("schema failed".into());
    for attempt in 0u8..4 {
        if attempt > 0 { sleep(Duration::from_millis(500)).await; }
        let local_port = state.pfm.ensure_tunnel(&key)?;
        match adapter.schema("127.0.0.1", local_port, &creds).await {
            Ok(r) => return Ok(r),
            Err(e) if is_fast_transient(&e) || is_slow_transient(&e) => { last_err = e; }
            Err(e) => return Err(e),
        }
    }
    Err(last_err)
}

fn build_tunnel_key(
    state: &AppState,
    source_id: &str,
    context: Option<&str>,
    namespace: String,
    service: String,
    remote_port: u16,
) -> TunnelKey {
    let kubeconfig_path = state
        .store
        .get_source(source_id)
        .and_then(|s| state.store.kubeconfig_path_for(&s))
        .map(|p| p.to_string_lossy().into_owned());

    TunnelKey {
        namespace,
        service,
        remote_port,
        kubeconfig_path,
        kube_context: context.filter(|s| !s.is_empty()).map(str::to_string),
    }
}

#[tauri::command]
pub async fn check_operator_installed(
    state: State<'_, AppState>,
    source_id: String,
    context: Option<String>,
    operator_id: String,
) -> Result<bool, AppError> {
    use kube::discovery::Discovery;

    let op = deploy::find_operator(&operator_id);
    let required_group = match op {
        Some(ref o) => o.crd_group(),
        None => return Ok(true), // unknown operator, assume installed
    };

    let client = state.store.build_client(&source_id, context.as_deref()).await?;
    let discovery = Discovery::new(client).run().await?;
    Ok(discovery.has_group(required_group))
}

#[tauri::command]
pub fn list_db_operators(_state: State<'_, AppState>) -> Vec<OperatorInfo> {
    deploy::list_operators()
}

#[tauri::command]
pub async fn install_operator(
    state: State<'_, AppState>,
    source_id: String,
    context: Option<String>,
    operator_id: String,
) -> Result<(), AppError> {
    use std::process::{Command, Stdio};

    let op = find_db_operator(&operator_id)
        .ok_or_else(|| AppError::Other(format!("Unknown operator: {operator_id}")))?;
    let info = op.info();

    let kubeconfig_path = state
        .store
        .get_source(&source_id)
        .and_then(|s| state.store.kubeconfig_path_for(&s))
        .map(|p| p.to_string_lossy().into_owned());

    let kube_context = context.filter(|s| !s.is_empty());

    let install_urls = op.install_urls();
    for url in &install_urls {
        info!("install_operator: applying {} from {}", info.name, url);
        let mut cmd = Command::new("kubectl");
        cmd.args(["apply", "--server-side", "-f", url]);
        if let Some(ref path) = kubeconfig_path {
            cmd.args(["--kubeconfig", path]);
        }
        if let Some(ref ctx) = kube_context {
            cmd.args(["--context", ctx]);
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let out = cmd.spawn()?.wait_with_output()?;
        if !out.status.success() {
            let msg = String::from_utf8_lossy(&out.stderr).to_string();
            return Err(AppError::Other(format!(
                "kubectl apply failed for {url}: {}", msg.trim()
            )));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn preview_deploy(params: DeployParams) -> Result<Vec<(String, String)>, AppError> {
    let op = find_db_operator(&params.operator_id)
        .ok_or_else(|| AppError::Other(format!("Unknown operator: {}", params.operator_id)))?;
    Ok(op.generate_manifests(&params))
}

#[tauri::command]
pub async fn deploy_database(
    state: State<'_, AppState>,
    source_id: String,
    context: Option<String>,
    params: DeployParams,
) -> Result<DeployStatus, AppError> {
    use std::io::Write as _;
    use std::process::{Command, Stdio};

    let op = find_db_operator(&params.operator_id)
        .ok_or_else(|| AppError::Other(format!("Unknown operator: {}", params.operator_id)))?;

    let kubeconfig_path = state
        .store
        .get_source(&source_id)
        .and_then(|s| state.store.kubeconfig_path_for(&s))
        .map(|p| p.to_string_lossy().into_owned());

    let kube_context: Option<String> = context
        .filter(|s| !s.is_empty());

    // Ensure the target namespace exists; create it if not.
    {
        let mut ns_cmd = Command::new("kubectl");
        ns_cmd.args(["create", "namespace", &params.namespace]);
        if let Some(ref path) = kubeconfig_path { ns_cmd.args(["--kubeconfig", path]); }
        if let Some(ref ctx) = kube_context { ns_cmd.args(["--context", ctx]); }
        ns_cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let ns_out = ns_cmd.spawn()?.wait_with_output()?;
        if !ns_out.status.success() {
            let msg = String::from_utf8_lossy(&ns_out.stderr);
            if !msg.contains("already exists") {
                return Err(AppError::Other(format!(
                    "Failed to create namespace '{}': {}", params.namespace, msg.trim()
                )));
            }
        }
    }

    let manifests = op.generate_manifests(&params);
    for (name, yaml) in &manifests {
        info!("deploy: applying manifest '{}'", name);
        let mut cmd = Command::new("kubectl");
        cmd.args(["apply", "-f", "-"]);
        if let Some(ref path) = kubeconfig_path {
            cmd.args(["--kubeconfig", path]);
        }
        if let Some(ref ctx) = kube_context {
            cmd.args(["--context", ctx]);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(yaml.as_bytes())?;
        }
        let out = child.wait_with_output()?;
        if !out.status.success() {
            let msg = String::from_utf8_lossy(&out.stderr).to_string();
            return Err(AppError::PortForward(format!(
                "kubectl apply failed for '{name}': {}", msg.trim()
            )));
        }
    }

    let service_name = op.service_name(&params);
    Ok(DeployStatus {
        phase: DeployPhase::Initializing,
        message: "Manifests applied — waiting for cluster to become ready".into(),
        service_name: Some(service_name),
    })
}

#[tauri::command]
pub async fn delete_database(
    state: State<'_, AppState>,
    source_id: String,
    context: Option<String>,
    operator_id: String,
    cr_name: String,
    namespace: String,
) -> Result<(), AppError> {
    use std::process::{Command, Stdio};

    let op = find_db_operator(&operator_id)
        .ok_or_else(|| AppError::Other(format!("Unknown operator: {operator_id}")))?;

    let kubeconfig_path = state
        .store
        .get_source(&source_id)
        .and_then(|s| state.store.kubeconfig_path_for(&s))
        .map(|p| p.to_string_lossy().into_owned());
    let kube_context = context.filter(|s| !s.is_empty());

    for (kind, name, ns) in op.resources_to_delete(&cr_name, &namespace) {
        info!("delete_database: kubectl delete {} {}/{}", kind, ns, name);
        let mut cmd = Command::new("kubectl");
        cmd.args(["delete", &kind, &name, "-n", &ns, "--ignore-not-found"]);
        if let Some(ref path) = kubeconfig_path { cmd.args(["--kubeconfig", path]); }
        if let Some(ref ctx) = kube_context { cmd.args(["--context", ctx]); }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let out = cmd.spawn()?.wait_with_output()?;
        if !out.status.success() {
            let msg = String::from_utf8_lossy(&out.stderr);
            return Err(AppError::Other(format!(
                "Failed to delete {} {}: {}", kind, name, msg.trim()
            )));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn get_deploy_status(
    state: State<'_, AppState>,
    source_id: String,
    context: Option<String>,
    namespace: String,
    name: String,
    operator_id: String,
) -> Result<DeployStatus, AppError> {
    use kube::api::{Api, DynamicObject};
    use kube::discovery::ApiResource;

    let op = find_db_operator(&operator_id)
        .ok_or_else(|| AppError::Other(format!("Unknown operator: {}", operator_id)))?;

    let client = state.store.build_client(&source_id, context.as_deref()).await?;

    // CloudNativePG uses a custom "Cluster" CRD; use DynamicObject to avoid depending on the CRD types
    let ar = ApiResource {
        group: "postgresql.cnpg.io".to_string(),
        version: "v1".to_string(),
        kind: "Cluster".to_string(),
        api_version: "postgresql.cnpg.io/v1".to_string(),
        plural: "clusters".to_string(),
    };
    let api: Api<DynamicObject> = Api::namespaced_with(client, &namespace, &ar);

    match api.get(&name).await {
        Ok(obj) => {
            let status = &obj.data["status"];
            let phase_str = status["phase"].as_str().unwrap_or("Initializing");

            let (phase, message) = if phase_str.to_lowercase().contains("healthy") || phase_str.to_lowercase().contains("ready") {
                (DeployPhase::Ready, phase_str.to_string())
            } else if phase_str.to_lowercase().contains("fail") || phase_str.to_lowercase().contains("error") {
                (DeployPhase::Failed, phase_str.to_string())
            } else {
                (DeployPhase::Initializing, phase_str.to_string())
            };

            let service_name = op.service_name(&DeployParams {
                operator_id: operator_id.clone(),
                namespace: namespace.clone(),
                name: name.clone(),
                // remaining fields irrelevant for service name
                instances: 1, pg_version: 17, storage_gi: 1,
                database: String::new(), username: String::new(), password: String::new(),
            });

            Ok(DeployStatus { phase, message, service_name: Some(service_name) })
        }
        Err(kube::Error::Api(ae)) if ae.code == 404 => {
            Ok(DeployStatus {
                phase: DeployPhase::Initializing,
                message: "Cluster resource not yet visible".into(),
                service_name: None,
            })
        }
        Err(e) => Err(AppError::Kube(e)),
    }
}

#[tauri::command]
pub async fn diagnose_connection(
    state: State<'_, AppState>,
    source_id: String,
    context: Option<String>,
    namespace: String,
    service: String,
    remote_port: u16,
    db_type: String,
    creds: Credentials,
) -> Result<Vec<DiagnosticCheck>, AppError> {
    use k8s_openapi::api::core::v1::{Endpoints, Pod};
    use kube::{api::ListParams, Api};

    let mut checks: Vec<DiagnosticCheck> = Vec::new();

    let client = state.store.build_client(&source_id, context.as_deref()).await?;

    let services: Api<k8s_openapi::api::core::v1::Service> =
        Api::namespaced(client.clone(), &namespace);
    let svc_result = services.get(&service).await;
    let selector_label = match &svc_result {
        Ok(svc) => {
            checks.push(DiagnosticCheck {
                id: "service".into(),
                label: "Service exists".into(),
                status: CheckStatus::Pass,
                detail: format!("Service '{service}' found in namespace '{namespace}'"),
                fix: None,
            });
            svc.spec.as_ref()
                .and_then(|s| s.selector.clone())
                .unwrap_or_default()
        }
        Err(_) => {
            checks.push(DiagnosticCheck {
                id: "service".into(),
                label: "Service exists".into(),
                status: CheckStatus::Fail,
                detail: format!("Service '{service}' not found in namespace '{namespace}'"),
                fix: Some(format!("kubectl get svc -n {namespace}")),
            });
            return Ok(checks);
        }
    };

    let pods: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let label_sel = selector_label
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(",");
    let lp = if label_sel.is_empty() {
        ListParams::default()
    } else {
        ListParams::default().labels(&label_sel)
    };

    match pods.list(&lp).await {
        Ok(pod_list) => {
            let running = pod_list.items.iter().filter(|p| {
                p.status.as_ref()
                    .and_then(|s| s.phase.as_deref())
                    .map(|ph| ph == "Running")
                    .unwrap_or(false)
            }).count();
            let total = pod_list.items.len();

            if running > 0 {
                checks.push(DiagnosticCheck {
                    id: "pods".into(),
                    label: "Pods running".into(),
                    status: CheckStatus::Pass,
                    detail: format!("{running}/{total} pod(s) Running"),
                    fix: None,
                });
            } else if total > 0 {
                let phases: Vec<_> = pod_list.items.iter()
                    .filter_map(|p| p.status.as_ref()?.phase.clone())
                    .collect();
                checks.push(DiagnosticCheck {
                    id: "pods".into(),
                    label: "Pods running".into(),
                    status: CheckStatus::Warn,
                    detail: format!("0/{total} pods Running — phases: {}", phases.join(", ")),
                    fix: Some(format!("kubectl describe pod -n {namespace} -l {label_sel}")),
                });
            } else {
                checks.push(DiagnosticCheck {
                    id: "pods".into(),
                    label: "Pods running".into(),
                    status: CheckStatus::Fail,
                    detail: "No pods found for this service".into(),
                    fix: Some(format!("kubectl get pods -n {namespace}")),
                });
            }
        }
        Err(e) => {
            checks.push(DiagnosticCheck {
                id: "pods".into(),
                label: "Pods running".into(),
                status: CheckStatus::Warn,
                detail: format!("Could not list pods: {e}"),
                fix: None,
            });
        }
    }

    let endpoints: Api<Endpoints> = Api::namespaced(client.clone(), &namespace);
    match endpoints.get(&service).await {
        Ok(ep) => {
            let ready_addrs: usize = ep.subsets.iter().flatten()
                .flat_map(|s| s.addresses.iter().flatten())
                .count();
            if ready_addrs > 0 {
                checks.push(DiagnosticCheck {
                    id: "endpoints".into(),
                    label: "Endpoints ready".into(),
                    status: CheckStatus::Pass,
                    detail: format!("{ready_addrs} ready address(es)"),
                    fix: None,
                });
            } else {
                checks.push(DiagnosticCheck {
                    id: "endpoints".into(),
                    label: "Endpoints ready".into(),
                    status: CheckStatus::Fail,
                    detail: "Service has no ready endpoints — pod may still be initializing".into(),
                    fix: Some(format!("kubectl get endpoints {service} -n {namespace}")),
                });
            }
        }
        Err(e) => {
            checks.push(DiagnosticCheck {
                id: "endpoints".into(),
                label: "Endpoints ready".into(),
                status: CheckStatus::Warn,
                detail: format!("Could not check endpoints: {e}"),
                fix: None,
            });
        }
    }

    let key = build_tunnel_key(
        &state,
        &source_id,
        context.as_deref(),
        namespace.clone(),
        service.clone(),
        remote_port,
    );
    match state.pfm.ensure_tunnel(&key) {
        Ok(local_port) => {
            checks.push(DiagnosticCheck {
                id: "portforward".into(),
                label: "Port-forward reachable".into(),
                status: CheckStatus::Pass,
                detail: format!("kubectl port-forward succeeded on local port {local_port}"),
                fix: None,
            });

            if let Some(adapter) = find_adapter(&db_type) {
                match adapter.test_connection("127.0.0.1", local_port, &creds).await {
                    Ok(()) => {
                        checks.push(DiagnosticCheck {
                            id: "auth".into(),
                            label: "Authentication".into(),
                            status: CheckStatus::Pass,
                            detail: format!("Connected as user '{}'", creds.user),
                            fix: None,
                        });
                    }
                    Err(e) => {
                        let detail = format!("{e}");
                        let fix = if detail.contains("role") || detail.contains("does not exist") {
                            Some("Database or role not yet created — wait for operator initialization".into())
                        } else if detail.contains("password") {
                            Some("Check your username and password".into())
                        } else {
                            None
                        };
                        checks.push(DiagnosticCheck {
                            id: "auth".into(),
                            label: "Authentication".into(),
                            status: CheckStatus::Fail,
                            detail,
                            fix,
                        });
                    }
                }
            }
        }
        Err(e) => {
            checks.push(DiagnosticCheck {
                id: "portforward".into(),
                label: "Port-forward reachable".into(),
                status: CheckStatus::Fail,
                detail: format!("{e}"),
                fix: Some(format!(
                    "kubectl port-forward -n {namespace} svc/{service} 5432:{remote_port}"
                )),
            });
        }
    }

    Ok(checks)
}
