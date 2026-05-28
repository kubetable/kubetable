import { Loader2, Play, Search, WrapText, ShieldOff, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { format as formatSql } from "sql-formatter";
import { useLayout } from "../lib/useLayout";
import { Connection, QueryTab } from "../types";
import { api, QueryResult } from "../lib/tauri";
import { ResultTable } from "./ResultTable";
import { addToHistory } from "../lib/history";

interface Props {
  connection: Connection;
  tab: QueryTab;
  onTabUpdate: (updates: Partial<QueryTab>) => void;
}

const WRITE_RE = /^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke|replace)\b/i;

function getWordAtCursor(text: string, pos: number): { word: string; start: number; end: number } {
  let start = pos;
  while (start > 0 && /\w/.test(text[start - 1])) start--;
  let end = pos;
  while (end < text.length && /\w/.test(text[end])) end++;
  return { word: text.slice(start, end), start, end };
}

export function QuerySheet({ connection, tab, onTabUpdate }: Props) {
  const { cluster, service, creds } = connection;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [vLayout, saveVLayout] = useLayout("kubetable:query-v", { editor: 35, results: 65 });
  const isReadOnly = !!creds.readOnly;
  const isRedis = connection.service.db_type.toLowerCase() === "redis";

  const connKey = `${service.namespace}/${service.name}`;

  // Load more state
  const accRowsRef = useRef<unknown[][]>([]);
  const loadOffsetRef = useRef(0);
  const [canLoadMore, setCanLoadMore] = useState(false);
  // Base SQL for active server filter (null = no filter active); load-more uses this when set
  const filterBaseRef = useRef<string | null>(null);
  // The user's original SQL before any filter was applied; restored when filter clears
  const userSqlRef = useRef<string>(tab.sql);
  // Incremented on fresh queries to tell ResultTable to reset its filter/sort state
  const [filterResetToken, setFilterResetToken] = useState(0);
  const [sqlFlash, setSqlFlash] = useState(false);
  const [flashMsg, setFlashMsg] = useState<string | null>(null);

  function flashEmpty() {
    setSqlFlash(true);
    setFlashMsg("No query to run");
    setTimeout(() => { setSqlFlash(false); setFlashMsg(null); }, 1500);
  }

  // Auto-refresh
  const [refreshSecs, setRefreshSecs] = useState(5);
  const [liveActive, setLiveActive] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const runQueryRef = useRef<(silent?: boolean) => void>(() => {});

  useEffect(() => {
    if (!liveActive) { setCountdown(null); return; }
    const totalMs = Math.max(1, refreshSecs) * 1000;
    let nextRun = Date.now() + totalMs;
    setCountdown(totalMs);
    const id = setInterval(() => {
      const rem = nextRun - Date.now();
      if (rem <= 0) {
        if (runQueryRef.current) runQueryRef.current(true);
        nextRun = Date.now() + totalMs;
        setCountdown(totalMs);
      } else {
        setCountdown(rem);
      }
    }, 50);
    return () => clearInterval(id);
  }, [liveActive, refreshSecs]);

  // Autocomplete state
  const [acItems, setAcItems] = useState<string[]>([]);
  const [acWord, setAcWord] = useState<{ word: string; start: number; end: number } | null>(null);
  const [acIndex, setAcIndex] = useState(0);

  useEffect(() => {
    accRowsRef.current = [];
    loadOffsetRef.current = 0;
    setCanLoadMore(false);
    setAcItems([]);
    setLiveActive(false);
  }, [tab.id]);

  const schemaSuggestions = useMemo(() => {
    const items = new Set<string>();
    for (const node of connection.schema) {
      const children = (node.kind === "Schema" || node.kind === "Database") ? node.children : [node];
      for (const child of children) {
        if (child.kind !== "Table") continue;
        items.add(child.name);
        for (const col of child.children) {
          if (col.kind !== "Column") continue;
          const m = col.name.match(/^(.+?):\s+/);
          items.add(m ? m[1] : col.name);
        }
      }
    }
    return Array.from(items).sort();
  }, [connection.schema]);

  function updateAutocomplete(text: string, cursorPos: number) {
    const { word, start, end } = getWordAtCursor(text, cursorPos);
    if (word.length < 2) {
      setAcItems([]);
      setAcWord(null);
      return;
    }
    const q = word.toLowerCase();
    const matches = schemaSuggestions.filter((s) => s.toLowerCase().startsWith(q)).slice(0, 8);
    if (matches.length > 0 && matches[0].toLowerCase() !== q) {
      setAcItems(matches);
      setAcWord({ word, start, end });
      setAcIndex(0);
    } else {
      setAcItems([]);
      setAcWord(null);
    }
  }

  function insertSuggestion(suggestion: string) {
    if (!acWord) return;
    const newSql = tab.sql.slice(0, acWord.start) + suggestion + tab.sql.slice(acWord.end);
    onTabUpdate({ sql: newSql });
    setAcItems([]);
    setAcWord(null);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = acWord.start + suggestion.length;
        textareaRef.current.setSelectionRange(pos, pos);
        textareaRef.current.focus();
      }
    });
  }

  async function runQuery(append = false, silent = false) {
    if (tab.running) return;
    if (!append && !tab.sql.trim()) { if (!silent) flashEmpty(); return; }
    if (isReadOnly && WRITE_RE.test(tab.sql)) {
      onTabUpdate({ error: "Read-only mode: write queries are blocked.", result: null, queryMs: null });
      return;
    }
    onTabUpdate({ running: true, error: null, ...(append ? {} : { result: null, queryMs: null }) });
    const start = Date.now();
    try {
      let sqlToRun = tab.sql;
      if (append) {
        // Use active filter base if one is set, otherwise strip LIMIT/OFFSET from tab.sql
        const base = filterBaseRef.current ?? tab.sql
          .replace(/;\s*$/, "")
          .replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?$/i, "");
        sqlToRun = `${base} LIMIT 100 OFFSET ${loadOffsetRef.current}`;
      } else {
        accRowsRef.current = [];
        loadOffsetRef.current = 0;
        filterBaseRef.current = null;
        userSqlRef.current = tab.sql;
        setFilterResetToken((t) => t + 1);
      }

      const result = await api.runQuery(
        cluster.sourceId, cluster.context,
        service.namespace, service.name, service.port, service.db_type, creds,
        sqlToRun,
      );

      const durationMs = Date.now() - start;

      if (append) {
        const allRows = [...accRowsRef.current, ...result.rows];
        accRowsRef.current = allRows;
        loadOffsetRef.current += result.rows.length;
        const combined: QueryResult = { ...result, rows: allRows, row_count: allRows.length };
        onTabUpdate({ result: combined, running: false, error: null, queryMs: durationMs });
        setCanLoadMore(result.rows.length >= 100);
        if (isRedis) setCanLoadMore(false);
      } else {
        accRowsRef.current = result.rows;
        loadOffsetRef.current = result.rows.length;
        onTabUpdate({ result, running: false, error: null, queryMs: durationMs });
        setCanLoadMore(result.rows.length >= 100);
        if (isRedis) setCanLoadMore(false);
        addToHistory(connKey, { sql: tab.sql, timestamp: Date.now(), durationMs, hadError: false });
      }
    } catch (e) {
      const durationMs = Date.now() - start;
      addToHistory(connKey, { sql: tab.sql, timestamp: Date.now(), durationMs, hadError: true });
      onTabUpdate({ error: String(e), running: false, result: null, queryMs: durationMs });
    }
  }

  async function handleLoadMore() {
    if (!canLoadMore || tab.running) return;
    await runQuery(true);
  }

  runQueryRef.current = (silent = false) => runQuery(false, silent);

  async function handleExplain() {
    if (tab.running) return;
    if (!tab.sql.trim()) { flashEmpty(); return; }
    onTabUpdate({ running: true, error: null, result: null });
    const start = Date.now();
    try {
      const result = await api.explainQuery(
        cluster.sourceId, cluster.context,
        service.namespace, service.name, service.port, service.db_type, creds,
        tab.sql,
      );
      onTabUpdate({ result, running: false, error: null, queryMs: Date.now() - start });
    } catch (e) {
      onTabUpdate({ error: String(e), running: false, queryMs: Date.now() - start });
    }
  }

  function handleFormat() {
    try {
      const formatted = formatSql(tab.sql, { language: "postgresql", tabWidth: 2, keywordCase: "upper" });
      onTabUpdate({ sql: formatted });
    } catch {
      // leave as-is if parse fails
    }
  }


  useEffect(() => {
    if (tab.autoRun) {
      onTabUpdate({ autoRun: false });
      runQuery();
    }
  }, [tab.autoRun]);

  const columnTypes = useMemo<Record<string, string>>(() => {
    const m = tab.sql.match(/\bfrom\s+([\w."'`]+(?:\.[\w."'`]+)?)/i);
    if (!m) return {};
    const raw = m[1].replace(/["`']/g, "").toLowerCase();
    const tbl = raw.includes(".") ? raw.split(".").pop()! : raw;
    const types: Record<string, string> = {};
    for (const node of connection.schema) {
      const children = (node.kind === "Schema" || node.kind === "Database")
        ? node.children : [node];
      for (const child of children) {
        if (child.kind === "Table" && child.name.toLowerCase() === tbl) {
          for (const col of child.children) {
            if (col.kind !== "Column") continue;
            const match = col.name.match(/^(.+?):\s+(.+)$/);
            if (match) types[match[1]] = match[2];
          }
        }
      }
    }
    return types;
  }, [tab.sql, connection.schema]);

  const handleServerFilter = useCallback(async (filters: Record<string, string>) => {
    if (tab.running) return;

    const conditions = Object.entries(filters)
      .filter(([, v]) => v.trim())
      .map(([col, val]) => {
        const escaped = val.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/'/g, "''");
        return `"${col}"::text ILIKE '%${escaped}%' ESCAPE '\\'`;
      });

    // Always build from the original user SQL, not the (possibly filtered) tab.sql
    const base = userSqlRef.current
      .replace(/;\s*$/, "")
      .replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?$/i, "");

    let filteredSql: string;
    let sqlForEditor: string;
    if (conditions.length > 0) {
      const queryBase = `SELECT * FROM (${base}) _q WHERE ${conditions.join(" AND ")}`;
      filterBaseRef.current = queryBase;
      filteredSql = `${queryBase} LIMIT 100`;
      sqlForEditor = filteredSql;
    } else {
      filterBaseRef.current = null;
      // Restore and re-run original SQL exactly — editor and execution stay in sync
      filteredSql = userSqlRef.current;
      sqlForEditor = userSqlRef.current;
    }

    onTabUpdate({ running: true, error: null, sql: sqlForEditor });
    const start = Date.now();
    accRowsRef.current = [];
    loadOffsetRef.current = 0;
    setCanLoadMore(false);
    try {
      const result = await api.runQuery(
        cluster.sourceId, cluster.context,
        service.namespace, service.name, service.port, service.db_type, creds,
        filteredSql,
      );
      accRowsRef.current = result.rows;
      loadOffsetRef.current = result.rows.length;
      setCanLoadMore(result.rows.length >= 100);
      onTabUpdate({ result, running: false, error: null, queryMs: Date.now() - start });
    } catch (e) {
      onTabUpdate({ error: String(e), running: false, queryMs: Date.now() - start });
    }
  }, [tab.running, cluster, service, creds, onTabUpdate]);

  async function fetchFkOptions(tableName: string): Promise<QueryResult> {
    return api.runQuery(
      cluster.sourceId, cluster.context,
      service.namespace, service.name, service.port, service.db_type, creds,
      `SELECT * FROM "${tableName}" LIMIT 200`,
    );
  }

  async function handleSaveChanges(sqls: string[]) {
    onTabUpdate({ running: true, error: null });
    try {
      for (const s of sqls) {
        await api.runQuery(
          cluster.sourceId, cluster.context,
          service.namespace, service.name, service.port, service.db_type, creds,
          s,
        );
      }
      runQuery();
    } catch (e) {
      onTabUpdate({ error: String(e), running: false });
    }
  }

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (acItems.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setAcIndex((i) => Math.min(i + 1, acItems.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setAcIndex((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Tab") { e.preventDefault(); insertSuggestion(acItems[acIndex]); return; }
      if (e.key === "Escape") { setAcItems([]); setAcWord(null); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runQuery();
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "f") {
      e.preventDefault();
      handleFormat();
    }
  }, [acItems, acIndex, tab.sql, tab.running]);

  return (
    <>
      <PanelGroup
        orientation="vertical"
        id={`query-sheet-${tab.id}`}
        className="query-sheet"
        defaultLayout={vLayout}
        onLayoutChanged={saveVLayout}
      >
        <Panel id="editor" minSize="15%" className="editor-panel">
          {isReadOnly && (
            <div className="readonly-banner">
              <ShieldOff size={11} />
              Read-only connection — write queries are blocked
            </div>
          )}
          <div className="editor-area">
            <textarea
              ref={textareaRef}
              className={`sql-editor ${tab.running ? "sql-editor--running" : ""} ${sqlFlash ? "sql-editor--flash" : ""}`}
              value={tab.sql}
              onChange={(e) => {
                onTabUpdate({ sql: e.target.value });
                updateAutocomplete(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyDown={handleKeyDown}
              onSelect={(e) => {
                const ta = e.currentTarget;
                if (acItems.length > 0) updateAutocomplete(ta.value, ta.selectionStart ?? ta.value.length);
              }}
              spellCheck={false}
              placeholder={isRedis ? "Enter Redis command (e.g. KEYS *, GET key, HGETALL key)…" : "Enter SQL query…"}
            />

            {/* Autocomplete dropdown */}
            {acItems.length > 0 && (
              <div className="ac-dropdown">
                {acItems.map((item, i) => (
                  <button
                    key={item}
                    className={`ac-item${i === acIndex ? " ac-item--active" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); insertSuggestion(item); }}
                    onMouseEnter={() => setAcIndex(i)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            )}

            <div className="editor-actions">
              <button
                className="format-btn"
                onClick={isRedis ? undefined : handleFormat}
                disabled={isRedis}
                title={isRedis ? "Format not available for Redis" : "Format SQL (⌘⇧F)"}
              >
                <WrapText size={13} />
                <span>Format</span>
              </button>

              {!isRedis && service.db_type.toLowerCase() !== "mongodb" && (
                <button
                  className="format-btn"
                  onClick={handleExplain}
                  disabled={tab.running}
                  title="EXPLAIN ANALYZE — show query execution plan"
                >
                  <Search size={13} />
                  <span>Explain</span>
                </button>
              )}

              <button
                className="run-btn"
                onClick={() => runQuery()}
                disabled={tab.running}
                title="Run query (⌘↵)"
              >
                {tab.running
                  ? <Loader2 size={13} className="spin" />
                  : <Play size={13} />
                }
                <span>Run</span>
                <kbd>⌘↵</kbd>
              </button>

              <div className="live-control">
                <div className="live-secs-wrap">
                  <input
                    type="number"
                    className="live-secs-input"
                    min={1}
                    value={refreshSecs}
                    onChange={(e) => setRefreshSecs(Math.max(1, parseInt(e.target.value) || 1))}
                    disabled={liveActive}
                    title="Refresh interval in seconds"
                  />
                  <span className="live-secs-label">s</span>
                </div>
                <button
                  className={`live-btn${liveActive ? " live-btn--active" : ""}`}
                  onClick={() => { if (!liveActive && !tab.sql.trim()) { flashEmpty(); return; } setLiveActive((a) => !a); }}
                  title={liveActive ? "Stop auto-refresh" : "Start auto-refresh"}
                >
                  <RefreshCw size={12} className={liveActive ? "spin-slow" : ""} />
                  <span>
                    {liveActive && countdown !== null
                      ? countdown >= 1000
                        ? `${(countdown / 1000).toFixed(1)}s`
                        : `${countdown}ms`
                      : "Live"}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </Panel>

        <PanelResizeHandle className="resize-handle resize-handle--horizontal" />

        <Panel id="results" minSize="15%" className="results-panel">
          {tab.error && (
            <div className="error-panel">{tab.error}</div>
          )}
          {tab.result && !tab.error && (
            <ResultTable
              result={tab.result}
              sql={tab.sql}
              isReadOnly={isReadOnly}
              columnTypes={columnTypes}
              onSaveChanges={isReadOnly ? undefined : handleSaveChanges}
              onFetchFkOptions={isReadOnly ? undefined : fetchFkOptions}
              onLoadMore={canLoadMore ? handleLoadMore : undefined}
              canLoadMore={canLoadMore}
              onRequery={isRedis ? undefined : handleServerFilter}
              filterResetToken={filterResetToken}
            />
          )}
          {!tab.error && !tab.result && !tab.running && (
            <div className="results-empty">
              <Play size={28} className={`results-empty-icon${flashMsg ? " results-empty-icon--warn" : ""}`} />
              <p className={flashMsg ? "results-empty-warn" : ""}>{flashMsg ?? "Run a query to see results"}</p>
              {!flashMsg && <p className="results-empty-hint">⌘↵ to execute</p>}
            </div>
          )}
          {tab.running && !tab.result && !tab.error && (
            <div className="results-empty">
              <Loader2 size={28} className="spin results-empty-icon" />
              <p>Running query…</p>
            </div>
          )}
        </Panel>
      </PanelGroup>

    </>
  );
}
