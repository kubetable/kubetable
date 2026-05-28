import { Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ClusterRef, ClusterSourceInfo } from "../lib/tauri";
import { ClusterManager } from "./ClusterManager";

interface Props {
  onClusterChange: (ref: ClusterRef) => void;
}

export function ClusterPicker({ onClusterChange }: Props) {
  const [sources, setSources] = useState<ClusterSourceInfo[]>([]);
  const [selected, setSelected] = useState<string>(""); // "sourceId::context"
  const [showManager, setShowManager] = useState(false);

  async function load(keepSelected?: string) {
    const all = await api.listClusterSources().catch(() => [] as ClusterSourceInfo[]);
    setSources(all);

    // Pick initial selection: current keepSelected, or default source's current_context
    const target = keepSelected ?? (() => {
      const def = all.find((s) => s.id === "default");
      if (def?.current_context) return `default::${def.current_context}`;
      if (def?.contexts[0]) return `default::${def.contexts[0]}`;
      return "";
    })();

    if (target) {
      setSelected(target);
      fireChange(target);
    }
  }

  useEffect(() => { load(); }, []);

  function fireChange(value: string) {
    const [sourceId, ...rest] = value.split("::");
    onClusterChange({ sourceId, context: rest.join("::") });
  }

  function handleSelectChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setSelected(e.target.value);
    fireChange(e.target.value);
  }

  return (
    <div className="cluster-picker">
      <label>Cluster</label>
      <select value={selected} onChange={handleSelectChange}>
        {sources.map((src) => (
          <optgroup key={src.id} label={src.label}>
            {src.contexts.map((ctx) => (
              <option key={ctx} value={`${src.id}::${ctx}`}>
                {ctx}
              </option>
            ))}
            {src.contexts.length === 0 && (
              <option disabled value="">
                (no contexts)
              </option>
            )}
          </optgroup>
        ))}
      </select>

      <button
        className="icon-btn"
        title="Manage cluster configs"
        onClick={() => setShowManager(true)}
      >
        <Settings size={14} />
      </button>

      {showManager && (
        <ClusterManager
          onClose={() => setShowManager(false)}
          onSourcesChanged={() => load(selected)}
        />
      )}
    </div>
  );
}
