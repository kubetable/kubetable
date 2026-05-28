import { invoke } from "@tauri-apps/api/core";

export interface ClusterSource {
  id: string;
  label: string;
  kind: "default" | "file" | "saved";
  path?: string;
}

export interface ClusterSourceInfo {
  id: string;
  label: string;
  kind: "default" | "file" | "saved";
  path?: string;
  contexts: string[];
  current_context: string | null;
}

export interface ClusterRef {
  sourceId: string;
  context: string;
}

export interface DiscoveredService {
  namespace: string;
  name: string;
  db_type: string;
  port: number;
  credential_secret: string | null;
  operator_id: string | null;
  operator_resource_name: string | null;
}

export interface Credentials {
  user: string;
  password: string;
  database: string | null;
  readOnly?: boolean;
}

export interface DetectedCredentials {
  user: string | null;
  password: string | null;
  database: string | null;
  source: string;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
}

export type SchemaNodeKind = "Database" | "Schema" | "Table" | "Column";

export interface SchemaNode {
  name: string;
  kind: SchemaNodeKind;
  children: SchemaNode[];
}

export const api = {
  // Cluster management
  listClusterSources: () =>
    invoke<ClusterSourceInfo[]>("list_cluster_sources"),
  addClusterFile: (path: string) =>
    invoke<ClusterSource>("add_cluster_file", { path }),
  addClusterYaml: (label: string, yaml: string) =>
    invoke<ClusterSource>("add_cluster_yaml", { label, yaml }),
  removeClusterSource: (id: string) =>
    invoke<void>("remove_cluster_source", { id }),

  // Legacy helpers (used by ClusterPicker for initial context)
  listContexts: () => invoke<string[]>("list_contexts"),
  currentContext: () => invoke<string | null>("current_context"),

  // Service discovery
  discoverServices: (sourceId: string, context?: string) =>
    invoke<DiscoveredService[]>("discover_services", {
      sourceId,
      context: context ?? null,
    }),

  // Namespaces
  listNamespaces: (sourceId: string, context: string) =>
    invoke<string[]>("list_namespaces", { sourceId, context: context || null }),

  // Credentials
  resolveCredentials: (sourceId: string, context: string, namespace: string, service: string, dbType?: string) =>
    invoke<DetectedCredentials>("resolve_credentials", {
      sourceId,
      context: context || null,
      namespace,
      service,
      dbType: dbType ?? null,
    }),

  // Connection
  connect: (
    sourceId: string,
    context: string,
    namespace: string,
    service: string,
    remotePort: number,
    dbType: string,
    creds: Credentials,
  ) =>
    invoke<number>("connect", {
      sourceId,
      context: context || null,
      namespace,
      service,
      remotePort,
      dbType,
      creds,
    }),

  disconnect: (sourceId: string, context: string, namespace: string, service: string, remotePort: number) =>
    invoke<void>("disconnect", {
      sourceId,
      context: context || null,
      namespace,
      service,
      remotePort,
    }),

  // Query
  runQuery: (
    sourceId: string,
    context: string,
    namespace: string,
    service: string,
    remotePort: number,
    dbType: string,
    creds: Credentials,
    sql: string,
  ) =>
    invoke<QueryResult>("run_query", {
      sourceId,
      context: context || null,
      namespace,
      service,
      remotePort,
      dbType,
      creds,
      sql,
    }),

  explainQuery: (
    sourceId: string,
    context: string,
    namespace: string,
    service: string,
    remotePort: number,
    dbType: string,
    creds: Credentials,
    sql: string,
  ) =>
    invoke<QueryResult>("explain_query", {
      sourceId,
      context: context || null,
      namespace,
      service,
      remotePort,
      dbType,
      creds,
      sql,
    }),

  getSchema: (
    sourceId: string,
    context: string,
    namespace: string,
    service: string,
    remotePort: number,
    dbType: string,
    creds: Credentials,
  ) =>
    invoke<SchemaNode[]>("get_schema", {
      sourceId,
      context: context || null,
      namespace,
      service,
      remotePort,
      dbType,
      creds,
    }),
};

export interface OperatorInfo {
  id: string;
  name: string;
  db_type: string;
  description: string;
  install_cmd: string;
  install_url: string;
  docs_url: string;
  remote_port: number;
}

export interface DeployParams {
  operator_id: string;
  namespace: string;
  name: string;
  instances: number;
  pg_version: number;
  storage_gi: number;
  database: string;
  username: string;
  password: string;
}

export type DeployPhase = "applying" | "initializing" | "ready" | "failed";

export interface DeployStatus {
  phase: DeployPhase;
  message: string;
  service_name: string | null;
}

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn";
  detail: string;
  fix: string | null;
}

export const deployApi = {
  listOperators: () => invoke<OperatorInfo[]>("list_db_operators", {}),

  checkOperatorInstalled: (sourceId: string, context: string, operatorId: string) =>
    invoke<boolean>("check_operator_installed", { sourceId, context: context || null, operatorId }),

  installOperator: (sourceId: string, context: string, operatorId: string) =>
    invoke<void>("install_operator", { sourceId, context: context || null, operatorId }),

  deleteDatabase: (sourceId: string, context: string, operatorId: string, crName: string, namespace: string) =>
    invoke<void>("delete_database", { sourceId, context: context || null, operatorId, crName, namespace }),

  previewDeploy: (params: DeployParams) =>
    invoke<[string, string][]>("preview_deploy", { params }),

  deployDatabase: (sourceId: string, context: string, params: DeployParams) =>
    invoke<DeployStatus>("deploy_database", {
      sourceId,
      context: context || null,
      params,
    }),

  getDeployStatus: (
    sourceId: string,
    context: string,
    namespace: string,
    name: string,
    operatorId: string,
  ) =>
    invoke<DeployStatus>("get_deploy_status", {
      sourceId,
      context: context || null,
      namespace,
      name,
      operatorId,
    }),

  diagnoseConnection: (
    sourceId: string,
    context: string,
    namespace: string,
    service: string,
    remotePort: number,
    dbType: string,
    creds: Credentials,
  ) =>
    invoke<DiagnosticCheck[]>("diagnose_connection", {
      sourceId,
      context: context || null,
      namespace,
      service,
      remotePort,
      dbType,
      creds,
    }),
};
