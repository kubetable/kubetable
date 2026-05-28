import { Clock, Play, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { clearHistory, deleteHistoryEntry, getHistory, HistoryEntry } from "../lib/history";

interface Props {
  connKey: string | null;
  onSelectQuery: (sql: string) => void;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function QueryHistoryPanel({ connKey, onSelectQuery }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (connKey) setEntries(getHistory(connKey));
    else setEntries([]);
  }, [connKey]);

  function handleDelete(id: string) {
    if (!connKey) return;
    deleteHistoryEntry(connKey, id);
    setEntries(getHistory(connKey));
  }

  function handleClear() {
    if (!connKey) return;
    clearHistory(connKey);
    setEntries([]);
  }

  if (!connKey) {
    return (
      <div className="panel-empty">
        <Clock size={24} className="panel-empty-icon" />
        <p>Connect to a database to see query history</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="panel-empty">
        <Clock size={24} className="panel-empty-icon" />
        <p>No query history yet</p>
        <p className="panel-empty-hint">Executed queries will appear here</p>
      </div>
    );
  }

  const filtered = search
    ? entries.filter((e) => e.sql.toLowerCase().includes(search.toLowerCase()))
    : entries;

  return (
    <div className="history-panel">
      <div className="history-header">
        <span className="history-count">
          {search && filtered.length !== entries.length
            ? `${filtered.length} of ${entries.length}`
            : `${entries.length} entries`}
        </span>
        <button className="history-clear-btn" onClick={handleClear} title="Clear all history">
          <X size={11} /> Clear
        </button>
      </div>
      <div className="history-search-wrap">
        <input
          className="history-search"
          placeholder="Search history…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button className="history-search-clear" onClick={() => setSearch("")} title="Clear search">
            ×
          </button>
        )}
      </div>
      <div className="history-list">
        {filtered.map((entry) => (
          <div key={entry.id} className={`history-item${entry.hadError ? " history-item--error" : ""}`}>
            <button
              className="history-run-btn"
              onClick={() => onSelectQuery(entry.sql)}
              title="Open query"
            >
              <Play size={10} />
            </button>
            <div className="history-body">
              <div className="history-sql">{entry.sql.trim().slice(0, 120)}{entry.sql.length > 120 ? "…" : ""}</div>
              <div className="history-meta">
                <span className="history-time">{timeAgo(entry.timestamp)}</span>
                {entry.durationMs != null && (
                  <span className="history-dur">{entry.durationMs}ms</span>
                )}
                {entry.hadError && <span className="history-err-badge">error</span>}
              </div>
            </div>
            <button
              className="history-delete-btn"
              onClick={() => handleDelete(entry.id)}
              title="Remove from history"
            >
              <Trash2 size={10} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
