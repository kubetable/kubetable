import { ChevronDown, ChevronRight, Columns, Copy, Info, Loader2, Play, RefreshCw, Search, Table } from "lucide-react";
import { useMemo, useState } from "react";
import { QueryResult, SchemaNode } from "../lib/tauri";
import { ContextMenu, ContextMenuDef } from "./ContextMenu";
import { TableDetailModal } from "./TableDetailModal";

interface Props {
  nodes: SchemaNode[];
  loading: boolean;
  onTableClick: (tableName: string, schemaName?: string) => void;
  onRefresh?: () => void;
  onQuery?: (sql: string) => Promise<QueryResult>;
  activeTable?: string | null;
  activeConnName?: string | null;
  dbType?: string;
}

interface FlatTable {
  schema: string;
  table: SchemaNode;
}

interface CtxState {
  x: number;
  y: number;
  table: SchemaNode;
  schema: string;
}

function flattenTables(nodes: SchemaNode[]): FlatTable[] {
  const out: FlatTable[] = [];
  for (const node of nodes) {
    if (node.kind === "Schema" || node.kind === "Database") {
      for (const child of node.children) {
        if (child.kind === "Table") out.push({ schema: node.name, table: child });
      }
    } else if (node.kind === "Table") {
      out.push({ schema: "", table: node });
    }
  }
  return out;
}

function TableRow({
  schema,
  table,
  isActive,
  onTableClick,
  onContextMenu,
}: {
  schema: string;
  table: SchemaNode;
  isActive: boolean;
  onTableClick: (t: string, s?: string) => void;
  onContextMenu: (e: React.MouseEvent, table: SchemaNode, schema: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const columns = table.children.filter((c) => c.kind === "Column");

  return (
    <div className="schema-table-group">
      <button
        className={`schema-table-row${isActive ? " schema-table-row--active" : ""}`}
        onDoubleClick={() => onTableClick(table.name, schema || undefined)}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, table, schema); }}
      >
        <span
          className="schema-tree-chevron"
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        >
          {columns.length > 0
            ? open ? <ChevronDown size={11} /> : <ChevronRight size={11} />
            : <span style={{ width: 11 }} />
          }
        </span>
        <Table size={12} className="schema-table-icon" />
        <span className="schema-table-name">{table.name}</span>
        {columns.length > 0 && (
          <span className="schema-col-count">{columns.length}</span>
        )}
      </button>
      {open && columns.length > 0 && (
        <div className="schema-columns">
          {columns.map((col) => {
            const match = col.name.match(/^(.+?):\s+(.+)$/);
            const colName = match ? match[1] : col.name;
            const colType = match ? match[2] : null;
            return (
              <div key={col.name} className="schema-col-row">
                <Columns size={11} className="schema-col-icon" />
                <span className="schema-col-name">{colName}</span>
                {colType && <span className="schema-col-type">{colType}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SchemaExplorer({ nodes, loading, onTableClick, onRefresh, onQuery, activeTable, activeConnName, dbType }: Props) {
  const [search, setSearch] = useState("");
  const [collapsedSchemas, setCollapsedSchemas] = useState<Set<string>>(new Set());
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [detailTable, setDetailTable] = useState<{ table: SchemaNode; schema: string } | null>(null);

  const flat = useMemo(() => flattenTables(nodes), [nodes]);

  const filtered = useMemo(() => {
    if (!search.trim()) return flat;
    const q = search.toLowerCase();
    return flat.filter((ft) => ft.table.name.toLowerCase().includes(q));
  }, [flat, search]);

  const grouped = useMemo(() => {
    const map: Record<string, FlatTable[]> = {};
    for (const ft of filtered) {
      const key = ft.schema || "(public)";
      if (!map[key]) map[key] = [];
      map[key].push(ft);
    }
    return map;
  }, [filtered]);

  const schemaNames = Object.keys(grouped).sort();

  function toggleSchema(name: string) {
    setCollapsedSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  function handleContextMenu(e: React.MouseEvent, table: SchemaNode, schema: string) {
    setCtx({ x: e.clientX, y: e.clientY, table, schema });
  }

  function buildCtxItems(table: SchemaNode, schema: string): ContextMenuDef[] {
    if (dbType?.toLowerCase() === "redis") {
      const cmd = table.name.endsWith(":*") ? `KEYS ${table.name}` : `GET ${table.name}`;
      return [
        { label: "Run command", icon: <Play size={12} />, shortcut: "⌘↩", onClick: () => onTableClick(table.name, schema || undefined) },
        "separator" as const,
        { label: "Copy key name", icon: <Copy size={12} />, onClick: () => navigator.clipboard.writeText(table.name) },
        { label: `Copy "${cmd}"`, icon: <Copy size={12} />, onClick: () => navigator.clipboard.writeText(cmd) },
      ];
    }
    const qualifiedDisplay = schema ? `${schema}.${table.name}` : table.name;
    const qualifiedSql = schema
      ? `"${schema}"."${table.name}"`
      : `"${table.name}"`;
    return [
      {
        label: "Open table",
        icon: <Play size={12} />,
        shortcut: "⌘↩",
        onClick: () => onTableClick(table.name, schema || undefined),
      },
      "separator",
      {
        label: "Show details",
        icon: <Info size={12} />,
        onClick: () => setDetailTable({ table, schema }),
      },
      "separator",
      {
        label: "Copy table name",
        icon: <Copy size={12} />,
        onClick: () => navigator.clipboard.writeText(table.name),
      },
      {
        label: "Copy qualified name",
        icon: <Copy size={12} />,
        onClick: () => navigator.clipboard.writeText(qualifiedDisplay),
      },
      {
        label: "Copy SELECT statement",
        icon: <Copy size={12} />,
        onClick: () => navigator.clipboard.writeText(`SELECT * FROM ${qualifiedSql} LIMIT 100;`),
      },
    ];
  }

  if (loading) {
    return (
      <div className="schema-explorer">
        <div className="schema-loading">
          <Loader2 size={16} className="spin" />
          <span>Loading schema…</span>
        </div>
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="schema-skeleton" style={{ width: `${60 + i * 8}%` }} />
        ))}
      </div>
    );
  }

  return (
    <div className="schema-explorer">
      <div className="schema-search-wrap">
        <Search size={12} className="schema-search-icon" />
        <input
          className="schema-search"
          placeholder={dbType?.toLowerCase() === "redis" ? "Filter keys…" : "Filter tables…"}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {onRefresh && (
          <button
            className="icon-btn schema-refresh-btn"
            title="Refresh tables"
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
          </button>
        )}
      </div>

      <div className="schema-tree-body">
        {nodes.length === 0 && !loading && (
          <div className="schema-empty">
            {activeConnName
              ? <><span>No tables found in</span><span className="schema-empty-conn">{activeConnName}</span></>
              : <span>Connect to a service to explore its schema</span>
            }
          </div>
        )}

        {schemaNames.map((schemaName) => {
          const isCollapsed = collapsedSchemas.has(schemaName);
          const tables = grouped[schemaName];
          return (
            <div key={schemaName} className="schema-ns-group">
              <button className="schema-ns-header" onClick={() => toggleSchema(schemaName)}>
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span className="schema-ns-name">{schemaName}</span>
                <span className="schema-ns-count">{tables.length}</span>
              </button>
              {!isCollapsed && (
                <div className="schema-ns-tables">
                  {tables.map((ft) => (
                    <TableRow
                      key={`${ft.schema}.${ft.table.name}`}
                      schema={ft.schema}
                      table={ft.table}
                      isActive={!!activeTable && ft.table.name === activeTable}
                      onTableClick={onTableClick}
                      onContextMenu={handleContextMenu}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={buildCtxItems(ctx.table, ctx.schema)}
          onClose={() => setCtx(null)}
        />
      )}

      {detailTable && (
        <TableDetailModal
          table={detailTable.table}
          schemaName={detailTable.schema}
          onClose={() => setDetailTable(null)}
          onQuery={onQuery}
        />
      )}
    </div>
  );
}
