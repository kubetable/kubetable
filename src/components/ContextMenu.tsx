import { useEffect, useLayoutEffect, useRef } from "react";

export interface ContextMenuEntry {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export type ContextMenuDef = ContextMenuEntry | "separator";

interface Props {
  x: number;
  y: number;
  items: ContextMenuDef[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw)   el.style.left = `${x - rect.width}px`;
    if (rect.bottom > vh)  el.style.top  = `${y - rect.height}px`;
  }, [x, y]);

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const els = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
      );
      if (!els.length) return;
      const idx = els.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown"
        ? (idx + 1) % els.length
        : (idx - 1 + els.length) % els.length;
      els[next].focus();
    }

    function onMouseDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    }

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="ctx-menu"
      style={{ position: "fixed", left: x, top: y }}
    >
      {items.map((item, i) =>
        item === "separator"
          ? <div key={i} role="separator" className="ctx-sep" />
          : (
            <button
              key={i}
              role="menuitem"
              className={`ctx-item${item.danger ? " ctx-item--danger" : ""}`}
              disabled={item.disabled}
              onClick={() => { item.onClick(); onClose(); }}
            >
              {item.icon && <span className="ctx-icon">{item.icon}</span>}
              <span className="ctx-label">{item.label}</span>
              {item.shortcut && <span className="ctx-shortcut">{item.shortcut}</span>}
            </button>
          )
      )}
    </div>
  );
}
