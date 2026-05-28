import { CheckCircle2, ChevronRight, Loader2, X, Eye, EyeOff, AlertTriangle, Plus, ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, deployApi, DeployParams, DeployStatus, OperatorInfo, ClusterSourceInfo, Credentials } from "../lib/tauri";
import type { ClusterRef } from "../lib/tauri";

export interface DeployConnectInfo {
  clusterRef: ClusterRef;
  namespace: string;
  serviceName: string;
  remotePort: number;
  dbType: string;
  creds: Credentials;
}

interface Props {
  clusterRef?: ClusterRef;
  namespace?: string;
  onClose: () => void;
  onConnectReady: (info: DeployConnectInfo) => void;
}

type Step = "cluster" | "operator" | "operator-check" | "configure" | "preview" | "deploy";
type CheckStatus = "idle" | "checking" | "installed" | "not-installed" | "installing" | "install-failed";

const PG_VERSIONS = [17, 16, 15, 14];
const STORAGE_OPTIONS = [1, 5, 10, 20, 50, 100];

function defaultsForOperator(op: OperatorInfo): Partial<{ name: string; pg_version: number; database: string; username: string }> {
  switch (op.db_type) {
    case "mysql":       return { name: "my-mysql",    pg_version: 0, database: "app", username: "app" };
    case "redis":       return { name: "my-redis",    pg_version: 0, database: "",    username: "" };
    case "mongodb":     return { name: "my-mongodb",  pg_version: 0, database: "app", username: "app" };
    case "cockroachdb": return { name: "my-cockroach",pg_version: 0, database: "app", username: "app" };
    default:            return { name: "my-postgres", pg_version: 17,database: "app", username: "app" };
  }
}

const STEP_LABELS: Record<Step, string> = {
  "cluster": "Cluster",
  "operator": "Operator",
  "operator-check": "Setup",
  "configure": "Configure",
  "preview": "Preview",
  "deploy": "Deploy",
};

export function DeployWizard({ clusterRef: initialRef, namespace: initNs, onClose, onConnectReady }: Props) {
  const [sources, setSources] = useState<ClusterSourceInfo[]>([]);
  const [selectedRef, setSelectedRef] = useState<ClusterRef | null>(initialRef ?? null);
  const [step, setStep] = useState<Step>(initialRef ? "operator" : "cluster");
  const [operators, setOperators] = useState<OperatorInfo[]>([]);
  const [selectedOp, setSelectedOp] = useState<OperatorInfo | null>(null);
  const [showPw, setShowPw] = useState(false);

  const [checkStatus, setCheckStatus] = useState<CheckStatus>("idle");
  const [installError, setInstallError] = useState<string | null>(null);

  const [form, setForm] = useState<DeployParams>({
    operator_id: "",
    namespace: initNs ?? "default",
    name: "my-postgres",
    instances: 1,
    pg_version: 17,
    storage_gi: 5,
    database: "app",
    username: "app",
    password: "",
  });

  // clusterNamespaces = what came from the API; namespaces = cluster + user-added
  const [clusterNamespaces, setClusterNamespaces] = useState<string[]>([]);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [nsMode, setNsMode] = useState<"select" | "new">("select");
  const [newNs, setNewNs] = useState("");
  const prevSelectNsRef = useRef<string>(""); // restores select value when cancelling new mode
  const [nsLoading, setNsLoading] = useState(false);
  const [manifests, setManifests] = useState<[string, string][]>([]);
  const [activeManifest, setActiveManifest] = useState(0);
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    deployApi.listOperators().then(setOperators);
    if (!initialRef) api.listClusterSources().then(setSources);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Fetch namespaces whenever the cluster ref changes
  useEffect(() => {
    const ref = selectedRef;
    if (!ref) return;
    setNsLoading(true);
    setNsMode("select");
    setNewNs("");
    api.listNamespaces(ref.sourceId, ref.context)
      .then(ns => {
        setClusterNamespaces(ns);
        setNamespaces(ns);
        // Auto-select: keep current if it exists in cluster, otherwise default or first
        setForm(current => ({
          ...current,
          namespace: ns.includes(current.namespace) ? current.namespace
            : ns.includes("default") ? "default"
            : ns[0] ?? current.namespace,
        }));
      })
      .catch(() => {})
      .finally(() => setNsLoading(false));
  }, [selectedRef]);

  // Run operator check whenever we enter the operator-check step
  useEffect(() => {
    if (step !== "operator-check" || !selectedRef || !selectedOp) return;
    runOperatorCheck();
  }, [step]);

  async function runOperatorCheck() {
    if (!selectedRef || !selectedOp) return;
    setCheckStatus("checking");
    setInstallError(null);
    try {
      const installed = await deployApi.checkOperatorInstalled(
        selectedRef.sourceId, selectedRef.context, selectedOp.id,
      );
      setCheckStatus(installed ? "installed" : "not-installed");
    } catch {
      setCheckStatus("not-installed");
    }
  }

  async function handleInstallOperator() {
    if (!selectedRef || !selectedOp) return;
    setCheckStatus("installing");
    setInstallError(null);
    try {
      await deployApi.installOperator(selectedRef.sourceId, selectedRef.context, selectedOp.id);
      // After install, verify it's now detected
      await runOperatorCheck();
    } catch (e) {
      setInstallError(String(e));
      setCheckStatus("install-failed");
    }
  }

  function isValidNsName(name: string): boolean {
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name);
  }

  function setField<K extends keyof DeployParams>(k: K, v: DeployParams[K]) {
    setForm(f => ({ ...f, [k]: v }));
  }

  async function handlePreview() {
    setError(null);
    setBusy(true);
    try {
      const result = await deployApi.previewDeploy({ ...form, operator_id: selectedOp!.id });
      const all: [string, string][] = [];
      // Prepend a Namespace manifest when the namespace doesn't exist in the cluster yet
      if (!clusterNamespaces.includes(form.namespace)) {
        all.push([
          `namespace: ${form.namespace}`,
          `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${form.namespace}\n`,
        ]);
      }
      all.push(...result);
      setManifests(all);
      setStep("preview");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeploy() {
    if (!selectedRef) return;
    setError(null);
    setBusy(true);
    setStep("deploy");
    setDeployStatus({ phase: "applying", message: "Applying manifests…", service_name: null });
    try {
      const status = await deployApi.deployDatabase(
        selectedRef.sourceId,
        selectedRef.context,
        { ...form, operator_id: selectedOp!.id },
      );
      setDeployStatus(status);

      pollRef.current = setInterval(async () => {
        try {
          const s = await deployApi.getDeployStatus(
            selectedRef.sourceId,
            selectedRef.context,
            form.namespace,
            form.name,
            selectedOp!.id,
          );
          setDeployStatus(s);
          if (s.phase === "ready" || s.phase === "failed") {
            clearInterval(pollRef.current!);
            pollRef.current = null;
          }
        } catch { /* keep polling */ }
      }, 3000);
    } catch (e) {
      setDeployStatus({ phase: "failed", message: String(e), service_name: null });
      setBusy(false);
    }
  }

  function handleConnect() {
    const serviceName = deployStatus?.service_name;
    if (selectedRef && serviceName && selectedOp) {
      const isRedis = selectedOp.db_type === "redis";
      onConnectReady({
        clusterRef: selectedRef,
        namespace: form.namespace,
        serviceName,
        remotePort: selectedOp.remote_port,
        dbType: selectedOp.db_type,
        creds: {
          user: isRedis ? "" : form.username,
          password: form.password,
          database: isRedis ? null : form.database || null,
        },
      });
    }
    onClose();
  }

  const isReady = deployStatus?.phase === "ready";

  const stepSequence: Step[] = initialRef
    ? ["operator", "operator-check", "configure", "preview", "deploy"]
    : ["cluster", "operator", "operator-check", "configure", "preview", "deploy"];

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal deploy-wizard">
        <div className="modal-header">
          <span>Deploy Database</span>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>

        {/* Step breadcrumb */}
        <div className="dw-steps">
          {stepSequence.map((s, i, arr) => {
            const idx = arr.indexOf(step as never);
            const done = idx > i;
            const active = step === s;
            return (
              <span key={s} className="dw-step-crumb">
                <span className={`dw-step-dot${active ? " dw-step-dot--active" : done ? " dw-step-dot--done" : ""}`}>{i + 1}</span>
                <span className={active ? "dw-step-label--active" : "dw-step-label"}>
                  {STEP_LABELS[s]}
                </span>
                {i < arr.length - 1 && <ChevronRight size={14} className="dw-step-sep" />}
              </span>
            );
          })}
        </div>

        <div className="dw-body">
          {/* ── Step 0: Cluster picker ── */}
          {step === "cluster" && (
            <div className="dw-section">
              <p className="dw-hint">Choose which cluster to deploy the database into.</p>
              <div className="dw-op-list">
                {sources.flatMap(src =>
                  src.contexts.map(ctx => {
                    const key = `${src.id}::${ctx}`;
                    const isSelected = selectedRef?.sourceId === src.id && selectedRef?.context === ctx;
                    return (
                      <button
                        key={key}
                        className={`dw-op-card${isSelected ? " dw-op-card--selected" : ""}`}
                        onClick={() => setSelectedRef({ sourceId: src.id, context: ctx })}
                      >
                        <span className="dw-op-name">{ctx}</span>
                        <span className="dw-op-desc">{src.label}</span>
                      </button>
                    );
                  })
                )}
                {sources.length === 0 && (
                  <p className="dw-hint">No clusters configured. Add a kubeconfig first.</p>
                )}
              </div>
            </div>
          )}

          {/* ── Step 1: Operator ── */}
          {step === "operator" && (
            <div className="dw-section">
              <p className="dw-hint">Choose a Kubernetes operator to deploy your database.</p>
              <div className="dw-op-list">
                {operators.map(op => (
                  <button
                    key={op.id}
                    className={`dw-op-card${selectedOp?.id === op.id ? " dw-op-card--selected" : ""}`}
                    onClick={() => { setSelectedOp(op); setForm(f => ({ ...f, ...defaultsForOperator(op) })); }}
                  >
                    <span className="dw-op-name">{op.name}</span>
                    <span className="dw-op-type">{op.db_type}</span>
                    <span className="dw-op-desc">{op.description}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Step 2: Operator check / setup ── */}
          {step === "operator-check" && selectedOp && (
            <div className="dw-section dw-check-section">
              {(checkStatus === "checking" || checkStatus === "idle") && (
                <div className="dw-check-state">
                  <Loader2 size={28} className="spin" />
                  <p className="dw-check-title">Checking cluster…</p>
                  <p className="dw-check-sub">Looking for {selectedOp.name} in this cluster</p>
                </div>
              )}

              {checkStatus === "installing" && (
                <div className="dw-check-state">
                  <Loader2 size={28} className="spin" />
                  <p className="dw-check-title">Installing {selectedOp.name}…</p>
                  <p className="dw-check-sub">Applying operator manifests to the cluster. This may take a moment.</p>
                </div>
              )}

              {checkStatus === "installed" && (
                <div className="dw-check-state dw-check-state--ok">
                  <CheckCircle2 size={28} />
                  <p className="dw-check-title">{selectedOp.name} is installed</p>
                  <p className="dw-check-sub">The operator is ready. Continue to configure your database.</p>
                </div>
              )}

              {(checkStatus === "not-installed" || checkStatus === "install-failed") && (
                <div className="dw-check-state dw-check-state--warn">
                  <AlertTriangle size={28} />
                  <p className="dw-check-title">{selectedOp.name} is not installed</p>
                  <p className="dw-check-sub">
                    The operator CRDs were not found in this cluster.
                    Let the wizard install it for you, or follow the manual steps below.
                  </p>

                  {installError && (
                    <div className="dw-install-error">{installError}</div>
                  )}

                  <button className="btn-primary dw-install-btn" onClick={handleInstallOperator}>
                    Install {selectedOp.name} for me
                  </button>

                  <details className="dw-install-manual">
                    <summary>Install manually instead</summary>
                    <div className="dw-install-block">
                      <p className="dw-install-label">Run this command, then click Re-check:</p>
                      <pre className="dw-install-cmd">{selectedOp.install_cmd}</pre>
                      <div className="dw-install-actions">
                        <a className="dw-docs-link" href={selectedOp.docs_url} target="_blank" rel="noreferrer">
                          Installation docs →
                        </a>
                        <button className="btn-secondary" onClick={runOperatorCheck}>
                          Re-check
                        </button>
                      </div>
                    </div>
                  </details>
                </div>
              )}
            </div>
          )}

          {/* ── Step 3: Configure ── */}
          {step === "configure" && (
            <div className="dw-section">
              <div className="dw-form">
                <div className="dw-label">
                  Namespace
                  {nsMode === "select" ? (
                    <div className="dw-ns-row">
                      <select
                        className="dw-input"
                        value={form.namespace}
                        onChange={e => setField("namespace", e.target.value)}
                        disabled={nsLoading}
                      >
                        {nsLoading && <option>Loading…</option>}
                        {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
                        {!nsLoading && namespaces.length === 0 && (
                          <option value="default">default</option>
                        )}
                      </select>
                      <button
                        type="button"
                        className="dw-ns-new-btn"
                        title="Create new namespace"
                        onClick={() => { prevSelectNsRef.current = form.namespace; setNsMode("new"); setNewNs(""); }}
                      >
                        <Plus size={13} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="dw-ns-row">
                        <input
                          className={`dw-input${newNs.trim() && (clusterNamespaces.includes(newNs.trim()) || !isValidNsName(newNs.trim())) ? " dw-input--warn" : ""}`}
                          autoFocus
                          placeholder="my-namespace"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          value={newNs}
                          onChange={e => {
                            const v = e.target.value.toLowerCase();
                            setNewNs(v);
                            setField("namespace", v.trim());
                          }}
                          onKeyDown={e => { if (e.key === "Escape") { setField("namespace", prevSelectNsRef.current); setNsMode("select"); } }}
                        />
                        <button
                          type="button"
                          className="dw-ns-new-btn"
                          title="Back to existing namespaces"
                          onClick={() => { setField("namespace", prevSelectNsRef.current); setNsMode("select"); }}
                        >
                          <ArrowLeft size={13} />
                        </button>
                      </div>
                      {newNs.trim() && !isValidNsName(newNs.trim()) && (
                        <span className="dw-ns-feedback dw-ns-feedback--warn">
                          Lowercase letters, numbers, and hyphens only — must start and end with a letter or number
                        </span>
                      )}
                      {newNs.trim() && isValidNsName(newNs.trim()) && clusterNamespaces.includes(newNs.trim()) && (
                        <span className="dw-ns-feedback dw-ns-feedback--warn">
                          Already exists — select it from the dropdown instead
                        </span>
                      )}
                      {newNs.trim() && isValidNsName(newNs.trim()) && !clusterNamespaces.includes(newNs.trim()) && (
                        <span className="dw-ns-feedback dw-ns-feedback--ok">
                          New namespace — will be created during deploy
                        </span>
                      )}
                    </>
                  )}
                </div>
                <label className="dw-label">
                  Instance name
                  <input className="dw-input" value={form.name} onChange={e => setField("name", e.target.value)} />
                  <span className="dw-field-hint">Name of the {selectedOp?.name ?? "operator"} resource in Kubernetes — also used as a prefix for the service and secret.</span>
                </label>
                <div className="dw-row">
                  {selectedOp?.db_type === "postgres" && (
                    <label className="dw-label">
                      PostgreSQL version
                      <select className="dw-input" value={form.pg_version} onChange={e => setField("pg_version", Number(e.target.value))}>
                        {PG_VERSIONS.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </label>
                  )}
                  <label className="dw-label">
                    Instances
                    <select className="dw-input" value={form.instances} onChange={e => setField("instances", Number(e.target.value))}>
                      {[1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                  <label className="dw-label">
                    Storage (Gi)
                    <select className="dw-input" value={form.storage_gi} onChange={e => setField("storage_gi", Number(e.target.value))}>
                      {STORAGE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                </div>
                {selectedOp?.db_type !== "redis" && (
                  <div className="dw-row">
                    <label className="dw-label">
                      Database name
                      <input className="dw-input" value={form.database} onChange={e => setField("database", e.target.value)} />
                    </label>
                    <label className="dw-label">
                      Username
                      <input className="dw-input" value={form.username} onChange={e => setField("username", e.target.value)} />
                    </label>
                  </div>
                )}
                <label className="dw-label">
                  Password
                  <div className="dw-pw-wrap">
                    <input
                      className="dw-input"
                      type={showPw ? "text" : "password"}
                      value={form.password}
                      onChange={e => setField("password", e.target.value)}
                      placeholder="Choose a strong password"
                    />
                    <button type="button" className="dw-pw-toggle" onClick={() => setShowPw(v => !v)}>
                      {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* ── Step 4: Preview ── */}
          {step === "preview" && (
            <div className="dw-section">
              <p className="dw-hint">Review the manifests that will be applied.</p>
              <div className="dw-manifest-tabs">
                {manifests.map(([name], i) => (
                  <button
                    key={name}
                    className={`dw-manifest-tab${activeManifest === i ? " dw-manifest-tab--active" : ""}`}
                    onClick={() => setActiveManifest(i)}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <pre className="dw-yaml">{manifests[activeManifest]?.[1] ?? ""}</pre>
            </div>
          )}

          {/* ── Step 5: Deploy ── */}
          {step === "deploy" && (
            <div className="dw-section dw-deploy-status">
              {deployStatus?.phase === "applying" && (
                <div className="dw-status-row">
                  <Loader2 size={20} className="spin" />
                  <span>Applying manifests to cluster…</span>
                </div>
              )}
              {deployStatus?.phase === "initializing" && (
                <div className="dw-status-row">
                  <Loader2 size={20} className="spin" />
                  <span>Cluster initializing — <em>{deployStatus.message}</em></span>
                </div>
              )}
              {isReady && (
                <div className="dw-status-row dw-status-row--ready">
                  <CheckCircle2 size={20} />
                  <span>Database is ready!</span>
                </div>
              )}
              {deployStatus?.phase === "failed" && (
                <div className="dw-status-row dw-status-row--fail">
                  <span>Deploy failed: {deployStatus.message}</span>
                </div>
              )}
            </div>
          )}

          {error && <div className="dw-error">{error}</div>}
        </div>

        {/* Footer actions */}
        <div className="modal-footer">
          {step === "cluster" && (
            <>
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" disabled={!selectedRef} onClick={() => setStep("operator")}>
                Next
              </button>
            </>
          )}
          {step === "operator" && (
            <>
              <button className="btn-secondary" onClick={() => initialRef ? onClose() : setStep("cluster")}>
                {initialRef ? "Cancel" : "Back"}
              </button>
              <button className="btn-primary" disabled={!selectedOp} onClick={() => { setCheckStatus("idle"); setStep("operator-check"); }}>
                Next
              </button>
            </>
          )}
          {step === "operator-check" && (
            <>
              <button className="btn-secondary" onClick={() => setStep("operator")}>Back</button>
              <button
                className="btn-primary"
                disabled={checkStatus !== "installed"}
                onClick={() => setStep("configure")}
              >
                {checkStatus === "installed" ? "Continue" : "Waiting for operator…"}
              </button>
            </>
          )}
          {step === "configure" && (
            <>
              <button className="btn-secondary" onClick={() => setStep("operator-check")}>Back</button>
              <button
                className="btn-primary"
                disabled={!form.name || !form.namespace || !form.password || busy || (nsMode === "new" && (!newNs.trim() || !isValidNsName(newNs.trim()) || clusterNamespaces.includes(newNs.trim())))}
                onClick={handlePreview}
              >
                {busy ? <Loader2 size={14} className="spin" /> : null} Preview YAML
              </button>
            </>
          )}
          {step === "preview" && (
            <>
              <button className="btn-secondary" onClick={() => setStep("configure")}>Back</button>
              <button className="btn-primary" onClick={handleDeploy}>
                Deploy
              </button>
            </>
          )}
          {step === "deploy" && (
            <>
              {!isReady && deployStatus?.phase !== "failed" && (
                <button className="btn-secondary" onClick={onClose}>Close (runs in background)</button>
              )}
              {isReady && (
                <button className="btn-primary" onClick={handleConnect}>
                  Connect now
                </button>
              )}
              {deployStatus?.phase === "failed" && (
                <button className="btn-secondary" onClick={onClose}>Close</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
