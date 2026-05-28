import { ClusterRef, Credentials, DiscoveredService, QueryResult, SchemaNode } from "./lib/tauri";

export interface QueryTab {
  id: string;
  label: string;
  sql: string;
  result: QueryResult | null;
  error: string | null;
  queryMs: number | null;
  running: boolean;
  autoRun?: boolean;
}

export interface Connection {
  id: string;
  cluster: ClusterRef;
  service: DiscoveredService;
  creds: Credentials;
  localPort: number;
  schema: SchemaNode[];
  schemaLoading: boolean;
  tabs: QueryTab[];
  activeTabId: string;
  color?: string;
}

let tabCounter = 0;

export function makeTab(label?: string): QueryTab {
  tabCounter += 1;
  return {
    id: crypto.randomUUID(),
    label: label ?? `Query ${tabCounter}`,
    sql: "",
    result: null,
    error: null,
    queryMs: null,
    running: false,
  };
}

export function makeConnection(
  cluster: ClusterRef,
  service: DiscoveredService,
  creds: Credentials,
  localPort: number,
): Connection {
  const firstTab = makeTab(service.name);
  return {
    id: crypto.randomUUID(),
    cluster,
    service,
    creds,
    localPort,
    schema: [],
    schemaLoading: true,
    tabs: [firstTab],
    activeTabId: firstTab.id,
  };
}
