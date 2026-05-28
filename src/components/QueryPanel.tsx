import { Loader2, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { useLayout } from "../lib/useLayout";
import { api, ClusterRef, Credentials, DiscoveredService, QueryResult, SchemaNode } from "../lib/tauri";
import { ResultTable } from "./ResultTable";
import { SchemaTree } from "./SchemaTree";

interface ConnectedInfo {
  cluster: ClusterRef;
  service: DiscoveredService;
  creds: Credentials;
  localPort: number;
}

interface Props {
  connection: ConnectedInfo;
}

export function QueryPanel({ connection }: Props) {
  const { cluster, service, creds } = connection;
  const [sql, setSql] = useState("SELECT * FROM ");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [schema, setSchema] = useState<SchemaNode[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [queryHLayout, saveQueryHLayout] = useLayout("kubetable:query-h", { schema: 20, main: 80 });
  const [queryVLayout, saveQueryVLayout] = useLayout("kubetable:query-v", { editor: 35, results: 65 });

  useEffect(() => {
    api
      .getSchema(cluster.sourceId, cluster.context, service.namespace, service.name, service.port, service.db_type, creds)
      .then(setSchema)
      .catch((e) => console.warn("Schema fetch failed:", e));
  }, [service, creds, cluster]);

  async function runQuery() {
    setRunning(true);
    setError(null);
    try {
      const r = await api.runQuery(
        cluster.sourceId, cluster.context,
        service.namespace, service.name, service.port, service.db_type, creds, sql,
      );
      setResult(r);
    } catch (e) {
      setError(String(e));
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runQuery();
    }
  }

  function handleTableClick(table: string) {
    setSql(`SELECT * FROM ${table} LIMIT 100;`);
    textareaRef.current?.focus();
  }

  return (
    <PanelGroup
      orientation="horizontal"
      id="query-panel"
      className="query-panel"
      defaultLayout={queryHLayout}
      onLayoutChanged={saveQueryHLayout}
    >
      <Panel id="schema" minSize="10%" maxSize="40%" className="schema-sidebar">
        <div className="sidebar-title">{service.namespace}/{service.name}</div>
        <SchemaTree nodes={schema} onTableClick={handleTableClick} />
      </Panel>

      <PanelResizeHandle className="resize-handle resize-handle--vertical" />

      <Panel id="main" className="query-main">
        <PanelGroup
          orientation="vertical"
          id="query-editor-results"
          defaultLayout={queryVLayout}
          onLayoutChanged={saveQueryVLayout}
        >
          <Panel id="editor" minSize="15%" className="editor-panel">
            <div className="editor-area">
              <textarea
                ref={textareaRef}
                className="sql-editor"
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                onKeyDown={handleKeyDown}
                spellCheck={false}
              />
              <button className="run-btn" onClick={runQuery} disabled={running}>
                {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                Run
                <kbd>⌘↵</kbd>
              </button>
            </div>
          </Panel>

          <PanelResizeHandle className="resize-handle resize-handle--horizontal" />

          <Panel id="results" minSize="15%" className="results-panel">
            {error && <div className="error-panel">{error}</div>}
            {result && <ResultTable result={result} />}
            {!error && !result && (
              <div className="empty-state" style={{ fontSize: 12 }}>Run a query to see results</div>
            )}
          </Panel>
        </PanelGroup>
      </Panel>
    </PanelGroup>
  );
}
