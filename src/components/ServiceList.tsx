import { Database, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ClusterRef, Credentials, DetectedCredentials, DiscoveredService } from "../lib/tauri";
import { CredentialModal } from "./CredentialModal";

interface ConnectedService {
  service: DiscoveredService;
  creds: Credentials;
  localPort: number;
}

interface Props {
  cluster: ClusterRef;
  onConnect: (info: ConnectedService) => void;
  activeService: DiscoveredService | null;
}

export function ServiceList({ cluster, onConnect, activeService }: Props) {
  const [services, setServices] = useState<DiscoveredService[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [pendingService, setPendingService] = useState<DiscoveredService | null>(null);
  const [detectedCreds, setDetectedCreds] = useState<DetectedCredentials | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  function serviceKey(s: DiscoveredService) {
    return `${s.namespace}/${s.name}`;
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setServices(await api.discoverServices(cluster.sourceId, cluster.context));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, [cluster.sourceId, cluster.context]);

  async function handleServiceClick(svc: DiscoveredService) {
    const key = serviceKey(svc);
    setResolving(key);
    setDetectedCreds(null);
    try {
      const detected = await api.resolveCredentials(
        cluster.sourceId, cluster.context, svc.namespace, svc.name,
      );
      setDetectedCreds(detected);
    } catch {
      setDetectedCreds(null);
    } finally {
      setResolving(null);
      setPendingService(svc);
    }
  }

  async function handleCredentials(creds: Credentials) {
    if (!pendingService) return;
    const svc = pendingService;
    setPendingService(null);
    setConnecting(serviceKey(svc));
    try {
      const localPort = await api.connect(
        cluster.sourceId, cluster.context,
        svc.namespace, svc.name, svc.port, svc.db_type, creds,
      );
      onConnect({ service: svc, creds, localPort });
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(null);
    }
  }

  return (
    <aside className="service-list">
      <div className="service-list-header">
        <span>Services</span>
        <button className="icon-btn" onClick={refresh} title="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>

      {loading && <div className="hint"><Loader2 size={14} className="spin" /> Scanning…</div>}
      {error && <div className="error-hint">{error}</div>}

      <div className="service-items">
      {services.map((svc) => {
        const key = serviceKey(svc);
        const isActive = activeService && serviceKey(activeService) === key;
        const isBusy = connecting === key || resolving === key;
        return (
          <button
            key={key}
            className={`service-item ${isActive ? "active" : ""}`}
            onClick={() => handleServiceClick(svc)}
            disabled={isBusy}
          >
            <Database size={14} />
            <span className="svc-name">{svc.name}</span>
            <span className="svc-ns">{svc.namespace}</span>
            <span className="svc-type">{svc.db_type}</span>
            {isBusy && <Loader2 size={12} className="spin" />}
          </button>
        );
      })}

      {!loading && services.length === 0 && !error && (
        <div className="hint">No DB services found</div>
      )}
      </div>

      {pendingService && (
        <CredentialModal
          service={pendingService}
          detected={detectedCreds}
          onSubmit={handleCredentials}
          onCancel={() => setPendingService(null)}
        />
      )}
    </aside>
  );
}
