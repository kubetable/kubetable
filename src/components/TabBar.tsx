import { Plus, X } from "lucide-react";
import { Connection, QueryTab } from "../types";

interface Props {
  connections: Connection[];
  activeConnId: string | null;
  onAddTab: (connId: string) => void;
  onCloseTab: (connId: string, tabId: string) => void;
  onSelectTab: (connId: string, tabId: string) => void;
}

function connColor(conn: Connection): string {
  if (conn.color) return conn.color;
  const colors = ["#58a6ff", "#3fb950", "#d29922", "#f78166", "#bc8cff", "#39d353"];
  let hash = 0;
  for (let i = 0; i < conn.id.length; i++) {
    hash = (hash * 31 + conn.id.charCodeAt(i)) >>> 0;
  }
  return colors[hash % colors.length];
}

export function TabBar({ connections, activeConnId, onAddTab, onCloseTab, onSelectTab }: Props) {
  if (connections.length === 0) {
    return (
      <div className="tab-bar">
        <span className="tab-bar-empty">No connection active</span>
      </div>
    );
  }

  return (
    <div className="tab-bar">
      <div className="tab-list">
        {connections.map((conn) => {
          const color = connColor(conn);
          const isActiveConn = conn.id === activeConnId;

          return (
            <div key={conn.id} className="tab-group">
              <span
                className={`tab-group-label ${isActiveConn ? "tab-group-label--active" : ""}`}
                style={{ color }}
                title={`${conn.service.namespace}/${conn.service.name}`}
              >
                {conn.service.namespace}/{conn.service.name}
              </span>
              {conn.tabs.map((tab: QueryTab) => {
                const isActive = isActiveConn && tab.id === conn.activeTabId;
                return (
                  <div
                    key={tab.id}
                    className={`tab ${isActive ? "tab--active" : ""}`}
                    onClick={() => onSelectTab(conn.id, tab.id)}
                    style={isActive ? { "--tab-accent": color } as React.CSSProperties : undefined}
                  >
                    <span className="tab-label">{tab.label}</span>
                    {tab.running && <span className="tab-running" />}
                    <button
                      className="tab-close"
                      onClick={(e) => { e.stopPropagation(); onCloseTab(conn.id, tab.id); }}
                      title="Close tab"
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
              <button
                className="tab-add"
                onClick={() => onAddTab(conn.id)}
                title={`New tab for ${conn.service.name}`}
              >
                <Plus size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
