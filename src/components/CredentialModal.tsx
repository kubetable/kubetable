import { useState } from "react";
import { ShieldOff } from "lucide-react";
import { Credentials, DetectedCredentials, DiscoveredService } from "../lib/tauri";

interface Props {
  service: DiscoveredService;
  detected: DetectedCredentials | null;
  onSubmit: (creds: Credentials) => void;
  onCancel: () => void;
}

export function CredentialModal({ service, detected, onSubmit, onCancel }: Props) {
  const dbType = service.db_type.toLowerCase();
  const isRedis = dbType === "redis";
  const isMongo = dbType === "mongodb";
  const isCassandra = dbType === "cassandra";

  const defaultUser = detected?.user ?? (isRedis ? "" : isMongo ? "admin" : isCassandra ? "" : "postgres");
  const defaultDb   = detected?.database ?? (isRedis ? "" : isMongo ? "admin" : "");

  const [user, setUser] = useState(defaultUser);
  const [password, setPassword] = useState(detected?.password ?? "");
  const [database, setDatabase] = useState(defaultDb);
  const [readOnly, setReadOnly] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit({
      user: isRedis ? "" : user,
      password,
      database: isRedis ? null : database || null,
      readOnly,
    });
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Connect to {service.namespace}/{service.name}</h3>

        {detected && (
          <div className={`detected-badge ${detected.user || detected.password ? "found" : "empty"}`}>
            {detected.user || detected.password
              ? `Auto-detected from ${detected.source}`
              : detected.source}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {!isRedis && (
            <label>
              User
              <input value={user} onChange={(e) => setUser(e.target.value)} required />
            </label>
          )}
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {!isRedis && (
            <label>
              {isCassandra ? "Keyspace" : "Database"}
              <input
                placeholder={isMongo ? "admin" : isCassandra ? "keyspace (optional)" : "postgres"}
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
              />
            </label>
          )}

          <div className="cred-readonly-row">
            <label className={`cred-readonly-toggle${readOnly ? " cred-readonly-toggle--on" : ""}`}>
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(e) => setReadOnly(e.target.checked)}
              />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <ShieldOff size={12} />
              Read-only mode
            </label>
          </div>

          <div className="modal-actions">
            <button type="button" onClick={onCancel}>Cancel</button>
            <button type="submit">Connect</button>
          </div>
        </form>
      </div>
    </div>
  );
}
