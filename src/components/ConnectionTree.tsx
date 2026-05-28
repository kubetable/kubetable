import { ChevronDown, ChevronRight, ChevronUp, Database, Eye, EyeOff, Loader2, Plus, RefreshCw, Settings, SquarePlus, Trash2, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, deployApi, ClusterRef, ClusterSourceInfo, Credentials, DetectedCredentials, DiscoveredService } from "../lib/tauri";
import { Connection, makeConnection } from "../types";
import { ClusterManager } from "./ClusterManager";
import { CredentialModal } from "./CredentialModal";
import { ContextMenu, ContextMenuDef } from "./ContextMenu";
import type { AppPlugin } from "../lib/plugins";

interface Props {
  activeConnId: string | null;
  connections: Connection[];
  onConnect: (conn: Connection) => void;
  onSetActive: (connId: string) => void;
  onColorChange?: (connId: string, color: string) => void;
  onAddTab?: (connId: string) => void;
  onDisconnect?: (connId: string) => void;
  onRefreshSchema?: (connId: string) => void;
  plugins?: AppPlugin[];
  onDeploy?: (clusterRef: ClusterRef) => void;
  refreshKey?: number;
  onDiagnose?: (payload: { clusterRef: ClusterRef; namespace: string; service: string; remotePort: number; dbType: string; creds: Credentials }) => void;
}

const PRESET_COLORS = [
  { label: "Red — production",  value: "#f85149" },
  { label: "Orange",            value: "#e3954a" },
  { label: "Yellow — staging",  value: "#d29922" },
  { label: "Green — dev/local", value: "#3fb950" },
  { label: "Blue",              value: "#58a6ff" },
  { label: "Purple",            value: "#bc8cff" },
];

function serviceKey(s: DiscoveredService) {
  return `${s.namespace}/${s.name}`;
}

// Drop headless services when a non-headless sibling with the same db_type exists in the same namespace.
// e.g. "postgres-headless" is dropped when "postgres" (same namespace + db_type) is present.
function deduplicateServices(svcs: DiscoveredService[]): DiscoveredService[] {
  const lookup = new Set(svcs.map((s) => `${s.namespace}/${s.name}/${s.db_type}`));
  return svcs.filter((s) => {
    if (!s.name.endsWith("-headless")) return true;
    const baseName = s.name.slice(0, -"-headless".length);
    return !lookup.has(`${s.namespace}/${baseName}/${s.db_type}`);
  });
}

function dbTypeBadgeClass(dbType: string): string {
  switch (dbType.toLowerCase()) {
    case "postgres": return "badge-postgres";
    case "mysql":    return "badge-mysql";
    case "redis":    return "badge-redis";
    default:         return "badge-default";
  }
}

function ColorPicker({ current, onSelect, onClear, onClose }: {
  current?: string;
  onSelect: (color: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div className="color-picker" ref={ref}>
      {PRESET_COLORS.map((c) => (
        <button
          key={c.value}
          className={`color-swatch ${current === c.value ? "color-swatch--active" : ""}`}
          style={{ background: c.value }}
          title={c.label}
          onClick={() => onSelect(c.value)}
        />
      ))}
      {current && (
        <button className="color-clear" title="Remove color" onClick={onClear}>✕</button>
      )}
    </div>
  );
}

function ClusterPicker({ sources, selectedKey, onChange, onManage }: {
  sources: ClusterSourceInfo[];
  selectedKey: string;
  onChange: (key: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const currentLabel = (() => {
    for (const src of sources) {
      for (const ctx of src.contexts) {
        if (`${src.id}::${ctx}` === selectedKey) return ctx;
      }
    }
    return "Select cluster…";
  })();

  // Only show sources that have at least one context
  const activeSources = sources.filter((s) => s.contexts.length > 0);

  return (
    <div className="cluster-picker" ref={ref}>
      <button
        className={`cluster-picker-btn${open ? " cluster-picker-btn--open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={currentLabel}
      >
        <span className="cluster-picker-label">{currentLabel}</span>
        {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
      </button>

      {open && (
        <div className="cluster-picker-dropdown">
          {activeSources.length === 0 ? (
            <div className="cluster-picker-empty">No clusters configured</div>
          ) : (
            activeSources.map((src, si) => (
              <div key={src.id}>
                {activeSources.length > 1 && (
                  <div className="cluster-picker-group">{src.label}</div>
                )}
                {src.contexts.map((ctx) => {
                  const key = `${src.id}::${ctx}`;
                  return (
                    <button
                      key={key}
                      className={`cluster-picker-item${key === selectedKey ? " cluster-picker-item--active" : ""}`}
                      onClick={() => { onChange(key); setOpen(false); }}
                      title={ctx}
                    >
                      {ctx}
                    </button>
                  );
                })}
                {si < activeSources.length - 1 && <div className="cluster-picker-sep" />}
              </div>
            ))
          )}
          <div className="cluster-picker-sep" />
          <button className="cluster-picker-manage" onClick={() => { setOpen(false); onManage(); }}>
            <Settings size={11} /> Manage clusters…
          </button>
        </div>
      )}
    </div>
  );
}

interface CtxState { x: number; y: number; conn: Connection | null; svc: DiscoveredService }

export function ConnectionTree({ activeConnId, connections, onConnect, onSetActive, onColorChange, onAddTab, onDisconnect, onRefreshSchema, plugins = [], onDeploy, onDiagnose, refreshKey }: Props) {
  const [sources, setSources] = useState<ClusterSourceInfo[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [showManager, setShowManager] = useState(false);
  const [allServices, setAllServices] = useState<DiscoveredService[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsedNs, setCollapsedNs] = useState<Set<string>>(new Set());
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [pendingService, setPendingService] = useState<DiscoveredService | null>(null);
  const [detectedCreds, setDetectedCreds] = useState<DetectedCredentials | null>(null);
  const [retryPayload, setRetryPayload] = useState<{ svc: DiscoveredService; creds: Credentials; ref: ClusterRef } | null>(null);
  const [colorPickerConnId, setColorPickerConnId] = useState<string | null>(null);
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ svc: DiscoveredService; conn: Connection | null } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function loadSources(keepSelected?: string) {
    const all = await api.listClusterSources().catch(() => [] as ClusterSourceInfo[]);
    setSources(all);
    const target = keepSelected ?? (() => {
      const def = all.find((s) => s.id === "default");
      if (def?.current_context) return `default::${def.current_context}`;
      if (def?.contexts[0]) return `default::${def.contexts[0]}`;
      return "";
    })();
    if (target && target !== selectedKey) setSelectedKey(target);
  }

  useEffect(() => { loadSources(); }, []);

  function parseKey(key: string): ClusterRef | null {
    if (!key) return null;
    const [sourceId, ...rest] = key.split("::");
    return { sourceId, context: rest.join("::") };
  }

  async function discover(cluster: ClusterRef) {
    setLoading(true);
    setError(null);
    setAllServices([]);
    try {
      const found = await api.discoverServices(cluster.sourceId, cluster.context);
      setAllServices(found);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const ref = parseKey(selectedKey);
    if (ref) discover(ref);
  }, [selectedKey, refreshKey]);

  function toggleNs(ns: string) {
    setCollapsedNs((prev) => {
      const next = new Set(prev);
      if (next.has(ns)) next.delete(ns);
      else next.add(ns);
      return next;
    });
  }

  async function handleServiceClick(svc: DiscoveredService) {
    const ref = parseKey(selectedKey);
    if (!ref) return;

    const existing = connections.find(
      (c) => c.service.namespace === svc.namespace && c.service.name === svc.name &&
        c.cluster.sourceId === ref.sourceId && c.cluster.context === ref.context
    );
    if (existing) { onSetActive(existing.id); return; }

    const key = serviceKey(svc);
    setConnectingKey(key);
    try {
      const detected = await api.resolveCredentials(ref.sourceId, ref.context, svc.namespace, svc.name, svc.db_type);
      setDetectedCreds(detected);
    } catch {
      setDetectedCreds(null);
    }
    setPendingService(svc);
    setConnectingKey(null);
  }

  async function doConnect(ref: ClusterRef, svc: DiscoveredService, creds: Credentials) {
    setConnectingKey(serviceKey(svc));
    setError(null);
    setRetryPayload(null);
    try {
      const localPort = await api.connect(
        ref.sourceId, ref.context,
        svc.namespace, svc.name, svc.port, svc.db_type, creds,
      );
      const conn = makeConnection(ref, svc, creds, localPort);
      onConnect(conn);
    } catch (e) {
      setError(String(e));
      setRetryPayload({ svc, creds, ref });
    } finally {
      setConnectingKey(null);
    }
  }

  async function handleCredentials(creds: Credentials) {
    if (!pendingService) return;
    const ref = parseKey(selectedKey);
    if (!ref) return;
    const svc = pendingService;
    setPendingService(null);
    setDetectedCreds(null);
    await doConnect(ref, svc, creds);
  }

  async function handleRetry() {
    if (!retryPayload) return;
    const { ref, svc, creds } = retryPayload;
    await doConnect(ref, svc, creds);
  }

  async function handleDeleteDatabase() {
    if (!deleteTarget) return;
    const { svc, conn } = deleteTarget;
    const ref = parseKey(selectedKey);
    if (!ref || !svc.operator_id || !svc.operator_resource_name) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      if (conn) onDisconnect?.(conn.id);
      await deployApi.deleteDatabase(ref.sourceId, ref.context, svc.operator_id, svc.operator_resource_name, svc.namespace);
      setDeleteTarget(null);
      discover(ref);
    } catch (e) {
      setDeleteError(String(e));
    } finally {
      setDeleting(false);
    }
  }

  function buildCtxItems(conn: Connection | null, svc: DiscoveredService): ContextMenuDef[] {
    if (!conn) {
      return [
        { label: "Connect", icon: <Database size={12} />, onClick: () => handleServiceClick(svc) },
      ];
    }
    return [
      {
        label: "New query tab",
        icon: <SquarePlus size={12} />,
        shortcut: "⌘T",
        onClick: () => { onSetActive(conn.id); onAddTab?.(conn.id); },
      },
      "separator",
      {
        label: "Refresh schema",
        icon: <RefreshCw size={12} />,
        onClick: () => { onSetActive(conn.id); onRefreshSchema?.(conn.id); },
      },
      {
        label: "Change color",
        icon: <span style={{ width: 12, height: 12, borderRadius: "50%", background: conn.color ?? "var(--text-dim)", display: "inline-block" }} />,
        onClick: () => setColorPickerConnId(colorPickerConnId === conn.id ? null : conn.id),
      },
      "separator",
      {
        label: "Copy service name",
        onClick: () => navigator.clipboard.writeText(`${svc.namespace}/${svc.name}`),
      },
      "separator",
      {
        label: "Disconnect",
        icon: <Unplug size={12} />,
        danger: true,
        onClick: () => onDisconnect?.(conn.id),
      },
      ...(svc.operator_id ? ["separator" as const, {
        label: "Delete database…",
        icon: <Trash2 size={12} />,
        danger: true,
        onClick: () => setDeleteTarget({ svc, conn }),
      }] : []),
    ];
  }

  const deduplicated = deduplicateServices(allServices);
  const hiddenKeys = new Set(
    allServices
      .filter((s) => !deduplicated.some((d) => d.namespace === s.namespace && d.name === s.name))
      .map((s) => serviceKey(s))
  );
  const services = showHidden ? allServices : deduplicated;

  const byNamespace: Record<string, DiscoveredService[]> = {};
  for (const svc of services) {
    if (!byNamespace[svc.namespace]) byNamespace[svc.namespace] = [];
    byNamespace[svc.namespace].push(svc);
  }
  const namespaces = Object.keys(byNamespace).sort();
  const ref = parseKey(selectedKey);
  const noSources = sources.length === 0 || sources.every((s) => s.contexts.length === 0);

  return (
    <div className="conn-tree">
      {/* Cluster picker + refresh */}
      <div className="conn-tree-header">
        <ClusterPicker
          sources={sources}
          selectedKey={selectedKey}
          onChange={setSelectedKey}
          onManage={() => setShowManager(true)}
        />
        {hiddenKeys.size > 0 && (
          <button
            className={`icon-btn${showHidden ? " icon-btn--active" : ""}`}
            title={showHidden ? "Hide duplicates" : `Show ${hiddenKeys.size} hidden service${hiddenKeys.size > 1 ? "s" : ""}`}
            onClick={() => setShowHidden((v) => !v)}
          >
            {showHidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
        <button
          className="icon-btn"
          title="Refresh services"
          onClick={() => ref && discover(ref)}
          disabled={loading}
        >
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
        </button>
      </div>

      {/* Services tree */}
      <div className="conn-tree-body">
        {error && (
          <div className="tree-error">
            <span className="tree-error-msg">{error}</span>
            <div className="tree-error-actions">
              {retryPayload && (
                <button className="tree-retry-btn" onClick={handleRetry} disabled={!!connectingKey}>
                  {connectingKey ? "Retrying…" : "Retry"}
                </button>
              )}
              {retryPayload && onDiagnose && (
                <button
                  className="tree-diag-btn"
                  onClick={() => onDiagnose({
                    clusterRef: retryPayload.ref,
                    namespace: retryPayload.svc.namespace,
                    service: retryPayload.svc.name,
                    remotePort: retryPayload.svc.port,
                    dbType: retryPayload.svc.db_type,
                    creds: retryPayload.creds,
                  })}
                >
                  Diagnose
                </button>
              )}
            </div>
          </div>
        )}

        {!loading && !error && noSources && (
          <div className="tree-empty">
            <Database size={28} className="tree-empty-icon" />
            <p>No clusters configured</p>
            <p className="tree-empty-hint">Add a kubeconfig to get started</p>
            <button className="tree-empty-btn" onClick={() => setShowManager(true)}>
              <Plus size={12} /> Add cluster
            </button>
          </div>
        )}

        {!loading && !error && !noSources && services.length === 0 && selectedKey && (
          <div className="tree-empty">
            <Database size={28} className="tree-empty-icon" />
            <p>No database services found</p>
            <p className="tree-empty-hint">Check your RBAC permissions or try a different namespace</p>
            {onDeploy && ref && (
              <button className="tree-empty-btn tree-deploy-btn" onClick={() => onDeploy(ref)}>
                <Plus size={12} /> Deploy a database
              </button>
            )}
          </div>
        )}

        {loading && (
          <div className="svc-skeleton-list">
            {[70, 55, 80, 45, 65].map((w, i) => (
              <div key={i} className="svc-skeleton" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}

        {!loading && namespaces.map((ns) => {
          const isCollapsed = collapsedNs.has(ns);
          return (
            <div key={ns} className="ns-group">
              <button className="ns-header" onClick={() => toggleNs(ns)}>
                <span className="ns-name">{ns}</span>
                <span className="ns-count">{byNamespace[ns].length}</span>
                {isCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
              </button>
              {!isCollapsed && (
                <div className="ns-services">
                  {byNamespace[ns].map((svc) => {
                    const key = serviceKey(svc);
                    const isBusy = connectingKey === key;
                    const conn = ref ? connections.find(
                      (c) => c.service.namespace === svc.namespace && c.service.name === svc.name &&
                        c.cluster.sourceId === ref.sourceId && c.cluster.context === ref.context
                    ) : undefined;
                    const isConnected = !!conn;
                    const isActive = conn?.id === activeConnId;
                    const dotColor = isConnected && conn?.color ? conn.color : undefined;

                    const isHidden = hiddenKeys.has(key);
                    return (
                      <div key={key} className="svc-row-wrap">
                        <button
                          className={`svc-row${isActive ? " svc-row--active" : ""}${isConnected && !isActive ? " svc-row--connected" : ""}${isHidden ? " svc-row--hidden" : ""}`}
                          onClick={() => handleServiceClick(svc)}
                          onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, conn: conn ?? null, svc }); }}
                          disabled={isBusy}
                          title={`${svc.namespace}/${svc.name} (${svc.db_type})`}
                        >
                          <span
                            className={`conn-dot ${isConnected ? "conn-dot--on" : "conn-dot--off"}`}
                            style={dotColor ? { background: dotColor, boxShadow: `0 0 5px ${dotColor}99` } : undefined}
                            onClick={isConnected && conn ? (e) => {
                              e.stopPropagation();
                              setColorPickerConnId(colorPickerConnId === conn.id ? null : conn.id);
                            } : undefined}
                            title={isConnected ? "Click to set environment color" : undefined}
                          />
                          <span className="svc-name">{svc.name}</span>
                          <span className={`svc-badge ${dbTypeBadgeClass(svc.db_type)}`}>{svc.db_type}</span>
                          {isBusy && <Loader2 size={11} className="spin svc-spinner" />}
                        </button>

                        {isConnected && conn && colorPickerConnId === conn.id && (
                          <ColorPicker
                            current={conn.color}
                            onSelect={(color) => { onColorChange?.(conn.id, color); setColorPickerConnId(null); }}
                            onClear={() => { onColorChange?.(conn.id, ""); setColorPickerConnId(null); }}
                            onClose={() => setColorPickerConnId(null)}
                          />
                        )}
                      </div>
                    );
                  })}
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
          items={buildCtxItems(ctx.conn, ctx.svc)}
          onClose={() => setCtx(null)}
        />
      )}

      {pendingService && (
        <CredentialModal
          service={pendingService}
          detected={detectedCreds}
          onSubmit={handleCredentials}
          onCancel={() => { setPendingService(null); setDetectedCreds(null); }}
        />
      )}

      {showManager && (
        <ClusterManager
          onClose={() => setShowManager(false)}
          onSourcesChanged={() => loadSources(selectedKey)}
          plugins={plugins}
        />
      )}

      {deleteTarget && (
        <div className="modal-overlay">
          <div className="modal">
            <h3 className="modal-title">Delete database</h3>
            <p className="modal-body">
              Delete <strong>{deleteTarget.svc.operator_resource_name ?? deleteTarget.svc.name}</strong> from namespace <strong>{deleteTarget.svc.namespace}</strong>?
            </p>
            <p className="modal-warning">
              This will delete the database cluster and credentials secret. Persistent volume claims are <em>not</em> deleted automatically.
            </p>
            {deleteError && <p className="modal-error">{deleteError}</p>}
            <div className="modal-actions">
              <button
                className="btn-secondary"
                onClick={() => { setDeleteTarget(null); setDeleteError(null); }}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="btn-danger"
                onClick={handleDeleteDatabase}
                disabled={deleting}
              >
                {deleting ? <><Loader2 size={12} className="spin" /> Deleting…</> : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
