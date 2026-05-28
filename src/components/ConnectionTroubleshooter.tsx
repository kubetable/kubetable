import { AlertTriangle, CheckCircle2, Copy, Loader2, RefreshCw, XCircle } from "lucide-react";
import { useState } from "react";
import { deployApi, DiagnosticCheck, Credentials } from "../lib/tauri";
import type { ClusterRef } from "../lib/tauri";

interface Props {
  clusterRef: ClusterRef;
  namespace: string;
  service: string;
  remotePort: number;
  dbType: string;
  creds: Credentials;
  onClose: () => void;
}

const StatusIcon = ({ status }: { status: DiagnosticCheck["status"] }) => {
  if (status === "pass") return <CheckCircle2 size={16} className="diag-icon diag-icon--pass" />;
  if (status === "fail") return <XCircle size={16} className="diag-icon diag-icon--fail" />;
  return <AlertTriangle size={16} className="diag-icon diag-icon--warn" />;
};

export function ConnectionTroubleshooter({ clusterRef, namespace, service, remotePort, dbType, creds, onClose }: Props) {
  const [checks, setChecks] = useState<DiagnosticCheck[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function runDiagnosis() {
    setRunning(true);
    setError(null);
    setChecks(null);
    try {
      const result = await deployApi.diagnoseConnection(
        clusterRef.sourceId,
        clusterRef.context,
        namespace,
        service,
        remotePort,
        dbType,
        creds,
      );
      setChecks(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  function copyFix(cmd: string) {
    navigator.clipboard.writeText(cmd);
    setCopied(cmd);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal diag-modal">
        <div className="modal-header">
          <span>Connection Diagnostics</span>
          <button className="modal-close" onClick={onClose}><span>×</span></button>
        </div>

        <div className="diag-target">
          <span className="diag-ns">{namespace}</span>/<span className="diag-svc">{service}</span>
          <span className="diag-port">:{remotePort}</span>
        </div>

        <div className="diag-body">
          {!checks && !running && !error && (
            <p className="diag-hint">Run diagnostics to check connectivity step by step.</p>
          )}

          {running && (
            <div className="diag-running">
              <Loader2 size={18} className="spin" />
              <span>Running checks…</span>
            </div>
          )}

          {error && <div className="dw-error">{error}</div>}

          {checks && (
            <div className="diag-checks">
              {checks.map(check => (
                <div key={check.id} className={`diag-check diag-check--${check.status}`}>
                  <div className="diag-check-header">
                    <StatusIcon status={check.status} />
                    <span className="diag-check-label">{check.label}</span>
                  </div>
                  <p className="diag-check-detail">{check.detail}</p>
                  {check.fix && (
                    <div className="diag-fix">
                      <code className="diag-fix-cmd">{check.fix}</code>
                      <button
                        className="diag-copy-btn"
                        onClick={() => copyFix(check.fix!)}
                        title="Copy command"
                      >
                        {copied === check.fix ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button className="btn-primary" onClick={runDiagnosis} disabled={running}>
            {running ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            {checks ? "Re-run" : "Run Diagnostics"}
          </button>
        </div>
      </div>
    </div>
  );
}
