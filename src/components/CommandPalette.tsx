import { useEffect, useRef, useState } from "react";
import { Search, Table, BookmarkCheck, Database, PlusCircle, Rocket, RefreshCw, Puzzle } from "lucide-react";
import type { SchemaNode } from "../lib/tauri";
import type { PluginCommand } from "../lib/plugins";

interface Props {
  connections: Array<{ id: string; label: string; color?: string; dbType: string }>;
  schema: SchemaNode[];
  savedQueries: Array<{ id: string; name: string; sql: string }>;
  pluginActions?: PluginCommand[];
  onClose: () => void;
  onSelectTable: (tableName: string, schemaName?: string) => void;
  onSelectQuery: (sql: string) => void;
  onSelectConnection: (connId: string) => void;
  onDeploy?: () => void;
  onRefreshClusters?: () => void;
}

interface ResultItem {
  key: string;
  group: "Actions" | "Tables" | "Saved Queries" | "Connections";
  icon: React.ReactNode;
  name: string;
  subtitle?: string;
  onSelect: () => void;
}

function flattenTables(
  nodes: SchemaNode[],
  parentName?: string,
): Array<{ tableName: string; schemaName?: string }> {
  const results: Array<{ tableName: string; schemaName?: string }> = [];
  for (const node of nodes) {
    if (node.kind === "Table") {
      results.push({ tableName: node.name, schemaName: parentName });
    } else if (node.kind === "Database" || node.kind === "Schema") {
      results.push(...flattenTables(node.children, node.name));
    } else {
      results.push(...flattenTables(node.children, parentName));
    }
  }
  return results;
}

export function CommandPalette({
  connections,
  schema,
  savedQueries,
  pluginActions = [],
  onClose,
  onSelectTable,
  onSelectQuery,
  onSelectConnection,
  onDeploy,
  onRefreshClusters,
}: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const lq = query.toLowerCase();

  const tableItems: ResultItem[] = flattenTables(schema)
    .filter(({ tableName }) => tableName.toLowerCase().includes(lq))
    .map(({ tableName, schemaName }) => ({
      key: `table:${schemaName ?? ""}:${tableName}`,
      group: "Tables" as const,
      icon: <Table size={14} />,
      name: tableName,
      subtitle: schemaName,
      onSelect: () => onSelectTable(tableName, schemaName),
    }));

  const queryItems: ResultItem[] = savedQueries
    .filter(({ name }) => name.toLowerCase().includes(lq))
    .map((q) => ({
      key: `query:${q.id}`,
      group: "Saved Queries" as const,
      icon: <BookmarkCheck size={14} />,
      name: q.name,
      subtitle: q.sql.length > 60 ? q.sql.slice(0, 60) + "…" : q.sql,
      onSelect: () => onSelectQuery(q.sql),
    }));

  const connItems: ResultItem[] = connections
    .filter(({ label }) => label.toLowerCase().includes(lq))
    .map((c) => ({
      key: `conn:${c.id}`,
      group: "Connections" as const,
      icon: <Database size={14} />,
      name: c.label,
      subtitle: c.dbType,
      onSelect: () => onSelectConnection(c.id),
    }));

  const allActions = [
    { key: "action:deploy", icon: <Rocket size={14} />, name: "Deploy database", subtitle: "Spin up a new DB in your cluster", onSelect: () => { onDeploy?.(); onClose(); } },
    { key: "action:refresh", icon: <RefreshCw size={14} />, name: "Refresh clusters", subtitle: "Re-scan cluster sources", onSelect: () => { onRefreshClusters?.(); onClose(); } },
    { key: "action:new-tab", icon: <PlusCircle size={14} />, name: "New tab", subtitle: "Open a blank query tab in active connection", onSelect: () => onClose() },
    ...pluginActions.map((action) => ({
      key: `plugin:${action.key}`,
      icon: action.icon ?? <Puzzle size={14} />,
      name: action.name,
      subtitle: action.subtitle,
      onSelect: () => { void action.run({ refreshClusters: () => onRefreshClusters?.(), openDeployWizard: () => onDeploy?.() }); onClose(); },
    })),
  ];
  const actionItems: ResultItem[] = allActions
    .filter(({ name }) => !lq || name.toLowerCase().includes(lq))
    .map((a) => ({ ...a, group: "Actions" as const }));

  type Group = ResultItem["group"];
  const groups: Array<{ label: Group; items: ResultItem[] }> = [
    { label: "Actions", items: actionItems },
    { label: "Tables", items: tableItems },
    { label: "Saved Queries", items: queryItems },
    { label: "Connections", items: connItems },
  ];

  const allItems = [...actionItems, ...tableItems, ...queryItems, ...connItems];

  // Reset active index when query changes
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLButtonElement>(
      `.cmd-item--active`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, allItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      allItems[activeIndex]?.onSelect();
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  // Build a flat index map so we can match group items to global index
  let globalIdx = 0;
  const groupsWithIndex = groups.map((g) => {
    const itemsWithIndex = g.items.map((item) => ({
      ...item,
      globalIndex: globalIdx++,
    }));
    return { ...g, items: itemsWithIndex };
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()}>
        <div className="cmd-input-wrap">
          <Search size={16} className="cmd-search-icon" />
          <input
            ref={inputRef}
            className="cmd-input"
            autoFocus
            placeholder="Search tables, queries, actions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="cmd-results" ref={listRef}>
          {allItems.length === 0 ? (
            <div className="cmd-empty">No results for "{query}"</div>
          ) : (
            groupsWithIndex.map((group) =>
              group.items.length === 0 ? null : (
                <div key={group.label}>
                  <div className="cmd-group-label">{group.label}</div>
                  {group.items.map((item) => (
                    <button
                      key={item.key}
                      className={`cmd-item${item.globalIndex === activeIndex ? " cmd-item--active" : ""}`}
                      onMouseEnter={() => setActiveIndex(item.globalIndex)}
                      onClick={item.onSelect}
                    >
                      <span className="cmd-item-icon">{item.icon}</span>
                      <span className="cmd-item-text">
                        <span className="cmd-item-name">{item.name}</span>
                        {item.subtitle && (
                          <span className="cmd-item-sub">{item.subtitle}</span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}
