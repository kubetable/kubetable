const MAX_ENTRIES = 200;

function storageKey(connKey: string): string {
  return `kubedb:history:${connKey}`;
}

export interface HistoryEntry {
  id: string;
  sql: string;
  timestamp: number;
  durationMs?: number;
  hadError: boolean;
  connKey: string;
}

export function addToHistory(
  connKey: string,
  entry: Omit<HistoryEntry, "id" | "connKey">
): void {
  const existing = getHistory(connKey).filter((e) => e.sql !== entry.sql);
  const next: HistoryEntry = {
    ...entry,
    id: crypto.randomUUID(),
    connKey,
  };
  const updated = [next, ...existing].slice(0, MAX_ENTRIES);
  localStorage.setItem(storageKey(connKey), JSON.stringify(updated));
}

export function getHistory(connKey: string): HistoryEntry[] {
  const raw = localStorage.getItem(storageKey(connKey));
  if (!raw) return [];
  return JSON.parse(raw) as HistoryEntry[];
}

export function deleteHistoryEntry(connKey: string, id: string): void {
  const updated = getHistory(connKey).filter((e) => e.id !== id);
  localStorage.setItem(storageKey(connKey), JSON.stringify(updated));
}

export function clearHistory(connKey: string): void {
  localStorage.removeItem(storageKey(connKey));
}
