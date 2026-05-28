import { useEffect, useMemo, useRef, useState } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { Bookmark, Clock, Database, LayoutList } from "lucide-react";
import "./App.css";
import { api } from "./lib/tauri";
import { useLayout } from "./lib/useLayout";
import { saveDraftSql, loadDraftSql, suggestConnectionColor } from "./lib/session";
import { createTelemetry, type AppPlugin } from "./lib/plugins";
import { Connection, makeTab, makeConnection, QueryTab } from "./types";
import { ConnectionTree } from "./components/ConnectionTree";
import { QuerySheet } from "./components/QuerySheet";
import { SchemaExplorer } from "./components/SchemaExplorer";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { QueryHistoryPanel } from "./components/QueryHistoryPanel";
import { SavedQueriesPanel } from "./components/SavedQueriesPanel";
import { DeployWizard } from "./components/DeployWizard";
import type { DeployConnectInfo } from "./components/DeployWizard";
import { ConnectionTroubleshooter } from "./components/ConnectionTroubleshooter";
import type { ClusterRef, DiscoveredService } from "./lib/tauri";
import { CommandPalette } from "./components/CommandPalette";
import { getSavedQueries } from "./lib/savedQueries";
import type { SavedQuery } from "./lib/savedQueries";

interface AppProps {
  plugins?: AppPlugin[];
}

function App({ plugins = [] }: AppProps) {
  const [showDeployWizard, setShowDeployWizard] = useState(false);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [showTroubleshooter, setShowTroubleshooter] = useState<null | {
    clusterRef: ClusterRef; namespace: string; service: string;
    remotePort: number; dbType: string; creds: import("./lib/tauri").Credentials;
  }>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeConnId, setActiveConnId] = useState<string | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [paletteQueries, setPaletteQueries] = useState<SavedQuery[]>([]);
  const [mainLayout, saveMainLayout] = useLayout("kubetable:main-layout-v4", { sidebar: 28, main: 72 });
  const [sidebarLayout, saveSidebarLayout] = useLayout("kubetable:sidebar-layout-v1", { connections: 45, schema: 55 });
  const [sidebarTab, setSidebarTab] = useState<"schema" | "saved" | "history">("schema");
  const telemetry = useMemo(() => createTelemetry(plugins), [plugins]);

  const connectionsRef = useRef(connections);
  useEffect(() => { connectionsRef.current = connections; }, [connections]);

  const sqlSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleSaveSql(conn: Connection, sql: string) {
    if (sqlSaveTimer.current) clearTimeout(sqlSaveTimer.current);
    sqlSaveTimer.current = setTimeout(() => {
      saveDraftSql(conn.cluster.sourceId, conn.cluster.context, conn.service.namespace, conn.service.name, sql);
    }, 1000);
  }

  const activeConn = connections.find((c) => c.id === activeConnId) ?? null;
  const activeTab = activeConn
    ? activeConn.tabs.find((t) => t.id === activeConn.activeTabId) ?? null
    : null;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (cmdOpen) setPaletteQueries(getSavedQueries());
  }, [cmdOpen]);

  function updateConn(connId: string, updates: Partial<Connection>) {
    setConnections((prev) =>
      prev.map((c) => (c.id === connId ? { ...c, ...updates } : c))
    );
  }

  function updateTab(connId: string, tabId: string, updates: Partial<QueryTab>) {
    if ("sql" in updates && updates.sql !== undefined) {
      const conn = connectionsRef.current.find((c) => c.id === connId);
      if (conn) scheduleSaveSql(conn, updates.sql);
    }
    setConnections((prev) =>
      prev.map((c) => {
        if (c.id !== connId) return c;
        return { ...c, tabs: c.tabs.map((t) => (t.id === tabId ? { ...t, ...updates } : t)) };
      })
    );
  }

  async function handleConnect(conn: Connection) {
    const savedSql = loadDraftSql(conn.cluster.sourceId, conn.cluster.context, conn.service.namespace, conn.service.name);
    const color = suggestConnectionColor(conn.cluster.context) ?? suggestConnectionColor(conn.service.name);
    const enriched: Connection = {
      ...conn,
      color,
      tabs: savedSql
        ? conn.tabs.map((t, i) => i === 0 ? { ...t, sql: savedSql } : t)
        : conn.tabs,
    };

    setConnections((prev) => [...prev, enriched]);
    setActiveConnId(conn.id);

    void telemetry.track({
      event: "cluster_connected",
      properties: { db_type: conn.service.db_type, namespace: conn.service.namespace },
    });

    try {
      const schema = await api.getSchema(
        conn.cluster.sourceId, conn.cluster.context,
        conn.service.namespace, conn.service.name,
        conn.service.port, conn.service.db_type, conn.creds,
      );
      updateConn(conn.id, { schema, schemaLoading: false });
    } catch (e) {
      console.warn("Schema load failed:", e);
      updateConn(conn.id, { schemaLoading: false });
    }
  }

  function handleAddTab(connId: string) {
    const conn = connections.find((c) => c.id === connId);
    if (!conn) return;
    const tab = makeTab();
    updateConn(connId, { tabs: [...conn.tabs, tab], activeTabId: tab.id });
    setActiveConnId(connId);
  }

  async function handleCloseTab(connId: string, tabId: string) {
    const conn = connections.find((c) => c.id === connId);
    if (!conn) return;
    const remaining = conn.tabs.filter((t) => t.id !== tabId);

    if (remaining.length === 0) {
      try {
        await api.disconnect(
          conn.cluster.sourceId, conn.cluster.context,
          conn.service.namespace, conn.service.name, conn.service.port,
        );
      } catch (e) {
        console.warn("Disconnect error:", e);
      }
      const newConns = connections.filter((c) => c.id !== connId);
      setConnections(newConns);
      setActiveConnId(newConns.length > 0 ? newConns[newConns.length - 1].id : null);
      return;
    }

    let newActiveTabId = conn.activeTabId;
    if (newActiveTabId === tabId) {
      const idx = conn.tabs.findIndex((t) => t.id === tabId);
      newActiveTabId = remaining[Math.min(idx, remaining.length - 1)].id;
    }
    updateConn(connId, { tabs: remaining, activeTabId: newActiveTabId });
  }

  function handleSelectTab(connId: string, tabId: string) {
    setActiveConnId(connId);
    updateConn(connId, { activeTabId: tabId });
  }

  function handleSidebarQuery(sql: string) {
    if (!activeConn) return;
    const tab = makeTab();
    updateConn(activeConn.id, {
      tabs: [...activeConn.tabs, { ...tab, sql, autoRun: false }],
      activeTabId: tab.id,
    });
  }

  function handleTableClick(tableName: string, schemaName?: string) {
    if (!activeConn) return;
    const dbType = activeConn.service.db_type.toLowerCase();
    let sql: string;
    if (dbType === "redis") {
      sql = tableName.endsWith(":*") ? `KEYS ${tableName}` : `GET ${tableName}`;
    } else if (dbType === "mysql") {
      const q = (s: string) => `\`${s}\``;
      const qualified = schemaName ? `${q(schemaName)}.${q(tableName)}` : q(tableName);
      sql = `SELECT * FROM ${qualified} LIMIT 100;`;
    } else if (dbType === "mongodb") {
      sql = schemaName ? `${schemaName}.${tableName}` : tableName;
    } else {
      const q = (s: string) => `"${s}"`;
      const qualified = schemaName ? `${q(schemaName)}.${q(tableName)}` : q(tableName);
      sql = `SELECT * FROM ${qualified} LIMIT 100;`;
    }
    const tab = makeTab(tableName);
    updateConn(activeConn.id, {
      tabs: [...activeConn.tabs, { ...tab, sql, autoRun: true }],
      activeTabId: tab.id,
    });
  }

  function handleColorChange(connId: string, color: string) {
    updateConn(connId, { color });
  }

  async function handleDeployConnect(info: DeployConnectInfo) {
    setShowDeployWizard(false);
    setTreeRefreshKey(k => k + 1);
    try {
      const localPort = await api.connect(
        info.clusterRef.sourceId, info.clusterRef.context,
        info.namespace, info.serviceName,
        info.remotePort, info.dbType, info.creds,
      );
      const svc: DiscoveredService = {
        namespace: info.namespace,
        name: info.serviceName,
        db_type: info.dbType,
        port: info.remotePort,
        credential_secret: null,
        operator_id: null,
        operator_resource_name: null,
      };
      const conn = makeConnection(info.clusterRef, svc, info.creds, localPort);
      await handleConnect(conn);
    } catch (e) {
      console.error("Deploy connect failed:", e);
    }
  }

  async function handleDisconnect(connId: string) {
    const conn = connections.find((c) => c.id === connId);
    if (!conn) return;
    try {
      await api.disconnect(
        conn.cluster.sourceId, conn.cluster.context,
        conn.service.namespace, conn.service.name, conn.service.port,
      );
    } catch (e) {
      console.warn("Disconnect error:", e);
    }
    const newConns = connections.filter((c) => c.id !== connId);
    setConnections(newConns);
    if (activeConnId === connId) setActiveConnId(newConns.length > 0 ? newConns[newConns.length - 1].id : null);
  }

  async function handleRefreshSchema(connId?: string) {
    const conn = connId ? connections.find((c) => c.id === connId) : activeConn;
    if (!conn) return;
    const { cluster, service, creds } = conn;
    updateConn(conn.id, { schemaLoading: true });
    try {
      const schema = await api.getSchema(
        cluster.sourceId, cluster.context,
        service.namespace, service.name,
        service.port, service.db_type, creds,
      );
      updateConn(conn.id, { schema, schemaLoading: false });
    } catch (e) {
      console.warn("Schema refresh failed:", e);
      updateConn(conn.id, { schemaLoading: false });
    }
  }

  const pluginContext = {
    refreshClusters: () => setTreeRefreshKey((k) => k + 1),
    openDeployWizard: () => setShowDeployWizard(true),
  };
  const pluginCommands = plugins.flatMap((plugin) => plugin.commandActions?.(pluginContext) ?? []);

  return (
    <div className="app">
      <header className="topbar">
        <span className="app-title">KubeTable</span>
        <div className="topbar-right">
          <button className="topbar-deploy-btn" onClick={() => setShowDeployWizard(true)}>
            + Deploy database
          </button>
          {plugins.map((plugin) => (
            <span key={plugin.id} className="topbar-plugin-slot">
              {plugin.topbarActions?.(pluginContext)}
            </span>
          ))}
        </div>
      </header>

      <div className="main-area">
        <PanelGroup
          orientation="horizontal"
          id="main-layout"
          className="panel-root"
          defaultLayout={mainLayout}
          onLayoutChanged={saveMainLayout}
        >
          <Panel id="sidebar" minSize="12%" maxSize="45%" className="sidebar-panel">
            <PanelGroup
              orientation="vertical"
              id="sidebar-layout"
              className="sidebar-layout"
              defaultLayout={sidebarLayout}
              onLayoutChanged={saveSidebarLayout}
            >
              <Panel id="connections" className="sidebar-connections-section">
                <ConnectionTree
                  activeConnId={activeConnId}
                  connections={connections}
                  onConnect={handleConnect}
                  onSetActive={setActiveConnId}
                  onColorChange={handleColorChange}
                  onAddTab={handleAddTab}
                  onDisconnect={handleDisconnect}
                  onRefreshSchema={handleRefreshSchema}
                  plugins={plugins}
                  onDeploy={() => setShowDeployWizard(true)}
                  onDiagnose={(payload) => setShowTroubleshooter(payload)}
                  refreshKey={treeRefreshKey}
                />
              </Panel>
              <PanelResizeHandle className="resize-handle resize-handle--horizontal" />
              <Panel id="schema" className="sidebar-schema-section">
                <div className="sidebar-tabs">
                  <button
                    className={`sidebar-tab${sidebarTab === "schema" ? " sidebar-tab--active" : ""}`}
                    onClick={() => setSidebarTab("schema")}
                    title="Schema explorer"
                  >
                    <LayoutList size={12} />
                    Schema
                  </button>
                  <button
                    className={`sidebar-tab${sidebarTab === "saved" ? " sidebar-tab--active" : ""}`}
                    onClick={() => setSidebarTab("saved")}
                    title="Saved queries"
                  >
                    <Bookmark size={12} />
                    Saved
                  </button>
                  <button
                    className={`sidebar-tab${sidebarTab === "history" ? " sidebar-tab--active" : ""}`}
                    onClick={() => setSidebarTab("history")}
                    title="Query history"
                  >
                    <Clock size={12} />
                    History
                  </button>
                </div>

                {sidebarTab === "schema" && (
                  <SchemaExplorer
                    nodes={activeConn?.schema ?? []}
                    loading={activeConn?.schemaLoading ?? false}
                    onTableClick={handleTableClick}
                    onRefresh={activeConn ? handleRefreshSchema : undefined}
                    onQuery={activeConn ? (sql) => {
                      const { cluster, service, creds } = activeConn;
                      return api.runQuery(cluster.sourceId, cluster.context, service.namespace, service.name, service.port, service.db_type, creds, sql);
                    } : undefined}
                    activeTable={activeTab?.label ?? null}
                    activeConnName={activeConn ? `${activeConn.service.namespace}/${activeConn.service.name}` : null}
                    dbType={activeConn?.service.db_type ?? "postgres"}
                  />
                )}

                {sidebarTab === "saved" && (
                  <SavedQueriesPanel
                    currentSql={activeTab?.sql}
                    onSelectQuery={handleSidebarQuery}
                  />
                )}

                {sidebarTab === "history" && (
                  <QueryHistoryPanel
                    connKey={activeConn ? `${activeConn.service.namespace}/${activeConn.service.name}` : null}
                    onSelectQuery={handleSidebarQuery}
                  />
                )}
              </Panel>
            </PanelGroup>
          </Panel>

          <PanelResizeHandle className="resize-handle resize-handle--vertical" />

          <Panel id="main" className="content-panel">
            <div className="content-area">
              <TabBar
                connections={connections}
                activeConnId={activeConnId}
                onAddTab={handleAddTab}
                onCloseTab={handleCloseTab}
                onSelectTab={handleSelectTab}
              />
              <div className="sheet-area">
                {activeConn && activeTab ? (
                  <QuerySheet
                    connection={activeConn}
                    tab={activeTab}
                    onTabUpdate={(updates) => updateTab(activeConn.id, activeTab.id, updates)}
                  />
                ) : (
                  <div className="empty-state">
                    <div className="empty-hero">
                      <Database size={28} className="empty-hero-icon" />
                      <h1 className="empty-hero-title">KubeTable</h1>
                      <p className="empty-hero-sub">Zero-config database access for Kubernetes</p>
                      <p className="empty-hero-hint">Select a service to connect</p>
                    </div>
                    <div className="empty-shortcuts">
                      <div className="empty-shortcut"><kbd>⌘</kbd>+<kbd>Enter</kbd><span>Run query</span></div>
                      <div className="empty-shortcut"><kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd><span>Format SQL</span></div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>

      <StatusBar connection={activeConn} activeTab={activeTab} />

      {showDeployWizard && (
        <DeployWizard
          clusterRef={connections.find(c => c.id === activeConnId)?.cluster ?? connections[0]?.cluster}
          onClose={() => { setShowDeployWizard(false); setTreeRefreshKey(k => k + 1); }}
          onConnectReady={handleDeployConnect}
        />
      )}

      {showTroubleshooter && (
        <ConnectionTroubleshooter
          {...showTroubleshooter}
          onClose={() => setShowTroubleshooter(null)}
        />
      )}

      {cmdOpen && (
        <CommandPalette
          connections={connections.map((c) => ({
            id: c.id,
            label: c.service.name,
            color: c.color,
            dbType: c.service.db_type,
          }))}
          schema={activeConn?.schema ?? []}
          savedQueries={paletteQueries}
          pluginActions={pluginCommands}
          onClose={() => setCmdOpen(false)}
          onSelectTable={(tableName, schemaName) => {
            handleTableClick(tableName, schemaName);
            setCmdOpen(false);
          }}
          onSelectQuery={(sql) => {
            handleSidebarQuery(sql);
            setCmdOpen(false);
          }}
          onSelectConnection={(connId) => {
            setActiveConnId(connId);
            setCmdOpen(false);
          }}
          onDeploy={() => {
            setShowDeployWizard(true);
            setCmdOpen(false);
          }}
          onRefreshClusters={() => {
            setTreeRefreshKey((k) => k + 1);
            setCmdOpen(false);
          }}
        />
      )}
    </div>
  );
}

export default App;
