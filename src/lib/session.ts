const DRAFT_SQL_KEY = "kubetable:draft-sql-v1";

function svcKey(sourceId: string, context: string, namespace: string, name: string) {
  return `${sourceId}::${context}::${namespace}::${name}`;
}

export function saveDraftSql(
  sourceId: string, context: string, namespace: string, name: string, sql: string
) {
  try {
    const drafts: Record<string, string> = JSON.parse(localStorage.getItem(DRAFT_SQL_KEY) ?? "{}");
    drafts[svcKey(sourceId, context, namespace, name)] = sql;
    // Keep at most 50 drafts — prune oldest by dropping first keys
    const keys = Object.keys(drafts);
    if (keys.length > 50) delete drafts[keys[0]];
    localStorage.setItem(DRAFT_SQL_KEY, JSON.stringify(drafts));
  } catch { /* ignore */ }
}

export function loadDraftSql(
  sourceId: string, context: string, namespace: string, name: string
): string | null {
  try {
    const drafts: Record<string, string> = JSON.parse(localStorage.getItem(DRAFT_SQL_KEY) ?? "{}");
    return drafts[svcKey(sourceId, context, namespace, name)] ?? null;
  } catch { return null; }
}

export function suggestConnectionColor(contextOrName: string): string | undefined {
  const n = contextOrName.toLowerCase();
  if (/prod/.test(n)) return "#f85149";
  if (/stag/.test(n)) return "#d29922";
  if (/dev|local|kind|k3d|minikube|docker|test/.test(n)) return "#3fb950";
  return undefined;
}
