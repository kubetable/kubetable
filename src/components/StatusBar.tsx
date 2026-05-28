import { Connection, QueryTab } from "../types";

interface Props {
  connection: Connection | null;
  activeTab: QueryTab | null;
}

export function StatusBar({ connection, activeTab }: Props) {
  if (!connection) {
    return (
      <div className="status-bar">
        <div className="status-left">
          <span className="status-dot status-dot--off" />
          <span className="status-text status-text--muted">No connection</span>
        </div>
      </div>
    );
  }

  const { service, localPort } = connection;

  return (
    <div className="status-bar">
      <div className="status-left">
        <span className="status-dot status-dot--on" />
        <span className="status-text">
          {service.namespace}/{service.name}
        </span>
      </div>
      <div className="status-center">
        <span className="status-badge">{service.db_type}</span>
        {activeTab?.result != null && (
          <span className="status-text status-text--muted">
            {activeTab.result.row_count} row{activeTab.result.row_count !== 1 ? "s" : ""}
          </span>
        )}
        {activeTab?.queryMs != null && (
          <span className="status-text status-text--muted">
            {activeTab.queryMs}ms
          </span>
        )}
      </div>
      <div className="status-right">
        <span className="status-text status-text--dim">:{localPort}</span>
      </div>
    </div>
  );
}
