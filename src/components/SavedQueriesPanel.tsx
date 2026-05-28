import { Bookmark, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { deleteQuery, getSavedQueries, saveQuery, SavedQuery, updateQuery } from "../lib/savedQueries";

interface Props {
  currentSql?: string;
  onSelectQuery: (sql: string) => void;
}

export function SavedQueriesPanel({ currentSql, onSelectQuery }: Props) {
  const [queries, setQueries] = useState<SavedQuery[]>(() => getSavedQueries());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [newName, setNewName] = useState("");

  function refresh() { setQueries(getSavedQueries()); }

  function handleSave() {
    if (!newName.trim() || !currentSql?.trim()) return;
    saveQuery(newName.trim(), currentSql.trim());
    setNewName("");
    setShowSaveForm(false);
    refresh();
  }

  function handleDelete(id: string) {
    deleteQuery(id);
    refresh();
  }

  function startRename(q: SavedQuery) {
    setEditingId(q.id);
    setEditName(q.name);
  }

  function commitRename(id: string) {
    if (editName.trim()) updateQuery(id, { name: editName.trim() });
    setEditingId(null);
    refresh();
  }

  return (
    <div className="saved-panel">
      <div className="saved-header">
        <span className="saved-count">
          {queries.length} saved
        </span>
        {currentSql?.trim() && (
          <button
            className="saved-add-btn"
            onClick={() => setShowSaveForm((v) => !v)}
            title="Save current query"
          >
            <Plus size={11} /> Save current
          </button>
        )}
      </div>

      {showSaveForm && (
        <div className="saved-form">
          <input
            autoFocus
            className="saved-name-input"
            placeholder="Query name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              if (e.key === "Escape") { setShowSaveForm(false); setNewName(""); }
            }}
          />
          <div className="saved-form-actions">
            <button className="saved-form-cancel" onClick={() => { setShowSaveForm(false); setNewName(""); }}>
              <X size={11} />
            </button>
            <button className="saved-form-submit" onClick={handleSave} disabled={!newName.trim()}>
              Save
            </button>
          </div>
        </div>
      )}

      {queries.length === 0 ? (
        <div className="panel-empty">
          <Bookmark size={24} className="panel-empty-icon" />
          <p>No saved queries</p>
          <p className="panel-empty-hint">Save the current query with the button above</p>
        </div>
      ) : (
        <div className="saved-list">
          {queries.map((q) => (
            <div key={q.id} className="saved-item">
              <button
                className="saved-run-btn"
                onClick={() => onSelectQuery(q.sql)}
                title="Open query"
              >
                <Play size={10} />
              </button>
              <div className="saved-body">
                {editingId === q.id ? (
                  <input
                    autoFocus
                    className="saved-rename-input"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => commitRename(q.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(q.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                ) : (
                  <div className="saved-name">{q.name}</div>
                )}
                <div className="saved-sql">{q.sql.trim().slice(0, 80)}{q.sql.length > 80 ? "…" : ""}</div>
              </div>
              <div className="saved-actions">
                <button className="saved-action-btn" onClick={() => startRename(q)} title="Rename">
                  <Pencil size={10} />
                </button>
                <button className="saved-action-btn saved-action-btn--danger" onClick={() => handleDelete(q.id)} title="Delete">
                  <Trash2 size={10} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
