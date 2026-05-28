import { useState } from "react";
import type { Layout } from "react-resizable-panels";

export function useLayout(storageKey: string, fallback: Layout): [Layout, (l: Layout) => void] {
  const [layout] = useState<Layout>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return JSON.parse(raw) as Layout;
    } catch {
      // ignore
    }
    return fallback;
  });

  function save(l: Layout) {
    try { localStorage.setItem(storageKey, JSON.stringify(l)); } catch { /* ignore */ }
  }

  return [layout, save];
}
