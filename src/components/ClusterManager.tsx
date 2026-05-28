import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ClusterSourceInfo } from "../lib/tauri";
import type { AppPlugin } from "../lib/plugins";

interface Props {
  onClose: () => void;
  onSourcesChanged: () => void;
  plugins?: AppPlugin[];
}

type AddMode = "file" | "yaml";

export function ClusterManager({ onClose, onSourcesChanged, plugins = [] }: Props) {
  const [sources, setSources] = useState<ClusterSourceInfo[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>("file");
  const [filePath, setFilePath] = useState("");
  const [yamlLabel, setYamlLabel] = useState("");
  const [yamlContent, setYamlContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setSources(await api.listClusterSources().catch(() => []));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd() {
    setBusy(true);
    setError(null);
    try {
      if (addMode === "file") {
        await api.addClusterFile(filePath.trim());
      } else {
        await api.addClusterYaml(yamlLabel.trim() || "Custom cluster", yamlContent.trim());
      }
      setFilePath("");
      setYamlLabel("");
      setYamlContent("");
      setShowAdd(false);
      await load();
      onSourcesChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.removeClusterSource(id);
      await load();
      onSourcesChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const pluginContext = {
    sources,
    refreshSources: load,
    notifySourcesChanged: onSourcesChanged,
  };

  return (
    <div className="modal-overlay">
      <div className="modal cm-modal">
        <div className="cm-header">
          <span>Manage Clusters</span>
          <button className="icon-btn" onClick={onClose}><X size={14} /></button>
        </div>

        {error && <div className="cm-error">{error}</div>}

        {/* Local cluster sources */}
        <div className="cm-list">
          {sources.map((s) => (
            <div key={s.id} className="cm-source">
              <div className="cm-source-info">
                <span className="cm-source-label">{s.label}</span>
                <span className="cm-source-meta">
                  {s.kind === "file" && <span className="cm-path" title={s.path}>{s.path}</span>}
                  <span className="cm-ctx-count">
                    {s.contexts.length} context{s.contexts.length !== 1 ? "s" : ""}
                  </span>
                </span>
              </div>
              {s.id !== "default" && (
                <button
                  className="icon-btn danger"
                  onClick={() => handleRemove(s.id)}
                  disabled={busy}
                  title="Remove"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>

        {!showAdd ? (
          <button className="cm-add-btn" onClick={() => setShowAdd(true)}>
            <Plus size={13} /> Add cluster config
          </button>
        ) : (
          <div className="cm-add-form">
            <div className="cm-tabs">
              <button
                className={addMode === "file" ? "active" : ""}
                onClick={() => setAddMode("file")}
              >
                File path
              </button>
              <button
                className={addMode === "yaml" ? "active" : ""}
                onClick={() => setAddMode("yaml")}
              >
                Paste YAML
              </button>
            </div>

            {addMode === "file" ? (
              <label className="cm-field">
                Path to kubeconfig file
                <input
                  autoFocus
                  placeholder="~/.kube/other-config"
                  value={filePath}
                  onChange={(e) => setFilePath(e.target.value)}
                />
              </label>
            ) : (
              <>
                <label className="cm-field">
                  Label
                  <input
                    autoFocus
                    placeholder="My cluster"
                    value={yamlLabel}
                    onChange={(e) => setYamlLabel(e.target.value)}
                  />
                </label>
                <label className="cm-field">
                  Kubeconfig YAML
                  <textarea
                    rows={8}
                    placeholder="Paste kubeconfig YAML here…"
                    value={yamlContent}
                    onChange={(e) => setYamlContent(e.target.value)}
                    className="cm-yaml"
                    spellCheck={false}
                  />
                </label>
              </>
            )}

            <div className="cm-form-actions">
              <button onClick={() => { setShowAdd(false); setError(null); }}>Cancel</button>
              <button
                className="primary"
                onClick={handleAdd}
                disabled={busy || (addMode === "file" ? !filePath.trim() : !yamlContent.trim())}
              >
                {busy ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
        )}

        {plugins.map((plugin) => {
          const section = plugin.clusterManagerSections?.(pluginContext);
          return section ? (
            <div key={plugin.id} className="cm-plugin-section">
              {section}
            </div>
          ) : null;
        })}
      </div>
    </div>
  );
}
