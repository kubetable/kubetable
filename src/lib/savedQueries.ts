const STORAGE_KEY = "kubetable:saved-queries";

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  createdAt: number;
}

export function getSavedQueries(): SavedQuery[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  return JSON.parse(raw) as SavedQuery[];
}

export function saveQuery(name: string, sql: string): SavedQuery {
  const query: SavedQuery = {
    id: crypto.randomUUID(),
    name,
    sql,
    createdAt: Date.now(),
  };
  const updated = [...getSavedQueries(), query];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return query;
}

export function updateQuery(
  id: string,
  updates: Partial<Pick<SavedQuery, "name" | "sql">>
): void {
  const updated = getSavedQueries().map((q) =>
    q.id === id ? { ...q, ...updates } : q
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function deleteQuery(id: string): void {
  const updated = getSavedQueries().filter((q) => q.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}
