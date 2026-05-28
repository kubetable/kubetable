import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, ArrowUpDown, Calendar, ChevronDown, Copy,
  Download, ExternalLink, Filter, Loader2, Pencil, Save,
  Search, SlidersHorizontal, Trash2, Undo2, X,
} from "lucide-react";
import { QueryResult } from "../lib/tauri";
import { ContextMenu, ContextMenuDef } from "./ContextMenu";

interface Props {
  result: QueryResult;
  sql?: string;
  isReadOnly?: boolean;
  columnTypes?: Record<string, string>;
  onSaveChanges?: (sqls: string[]) => void;
  onFetchFkOptions?: (table: string) => Promise<QueryResult>;
  onLoadMore?: () => void;
  canLoadMore?: boolean;
  /** Called with active filters to re-run the query server-side */
  onRequery?: (filters: Record<string, string>) => void;
  /** Increment to reset filter/sort state (e.g. on fresh user-initiated query) */
  filterResetToken?: number;
}

type CellType = "boolean" | "integer" | "float" | "date" | "datetime" | "enum" | "json" | "text";

const PG_INT    = /^(int|integer|bigint|smallint|serial|bigserial|smallserial)$/i;
const PG_FLOAT  = /^(numeric|decimal|real|double precision|float|money)$/i;
const PG_BOOL   = /^bool(ean)?$/i;
const PG_DATE   = /^date$/i;
const PG_TS     = /^timestamp/i;
const PG_STD    = /^(text|varchar|char|character|uuid|json|jsonb|bytea|xml|inet|cidr|macaddr|bit|tsvector|tsquery|point|line|lseg|box|path|polygon|circle|int4range|int8range|numrange|tsrange|tstzrange|daterange)/i;

function detectType(value: unknown, pgType?: string, enumOptions?: string[]): CellType {
  if (enumOptions && enumOptions.length > 0) return "enum";
  if (pgType) {
    if (PG_BOOL.test(pgType))  return "boolean";
    if (PG_INT.test(pgType))   return "integer";
    if (PG_FLOAT.test(pgType)) return "float";
    if (PG_DATE.test(pgType))  return "date";
    if (PG_TS.test(pgType))    return "datetime";
    if (!PG_STD.test(pgType) && typeof value === "string") return "enum";
    return "text";
  }
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number")  return Number.isInteger(value) ? "integer" : "float";
  if (value !== null && typeof value === "object") return "json";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(value)) return "datetime";
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  }
  return "text";
}

function toDraft(value: unknown, type: CellType): string {
  if (value === null || value === undefined) return "";
  if (type === "datetime" && typeof value === "string") return value.replace(" ", "T").slice(0, 19);
  return String(value);
}

function formatSqlValue(newVal: string | null, type: CellType): string {
  if (newVal === null || newVal === "") return "NULL";
  if (type === "boolean") return newVal === "true" ? "TRUE" : "FALSE";
  if (type === "integer") { const n = parseInt(newVal, 10); return isNaN(n) ? `'${esc(newVal)}'` : String(n); }
  if (type === "float")   { const n = parseFloat(newVal);   return isNaN(n) ? `'${esc(newVal)}'` : String(n); }
  return `'${esc(newVal)}'`;
}

function esc(s: string) { return s.replace(/'/g, "''"); }

function parseTableName(sql: string): string | null {
  const m = sql.match(/\bfrom\s+([\w."'`]+(?:\.[\w."'`]+)?)/i);
  return m ? m[1].replace(/["`']/g, "") : null;
}

function findPkColumn(columns: string[]): string | null {
  return columns.find((c) => c.toLowerCase() === "id")
    ?? columns.find((c) => /(_id|id)$/i.test(c))
    ?? null;
}

function quoteIdent(n: string) { return `"${n.replace(/"/g, '""')}"`; }

function quoteVal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function buildWhere(columns: string[], row: Record<string, unknown>): string {
  const pk = findPkColumn(columns);
  if (pk) {
    const v = row[pk];
    return v == null ? `${quoteIdent(pk)} IS NULL` : `${quoteIdent(pk)} = ${quoteVal(v)}`;
  }
  return columns.map((c) => {
    const v = row[c];
    return v == null ? `${quoteIdent(c)} IS NULL` : `${quoteIdent(c)} = ${quoteVal(v)}`;
  }).join(" AND ");
}

function buildUpdateMulti(
  table: string,
  changes: { col: string; newVal: string | null; type: CellType }[],
  columns: string[],
  row: Record<string, unknown>,
): string {
  const sets = changes.map(({ col, newVal, type }) =>
    `${quoteIdent(col)} = ${formatSqlValue(newVal, type)}`
  ).join(", ");
  return `UPDATE ${table} SET ${sets} WHERE ${buildWhere(columns, row)};`;
}

function buildDelete(table: string, columns: string[], row: Record<string, unknown>): string {
  return `DELETE FROM ${table} WHERE ${buildWhere(columns, row)};`;
}

function buildInsert(table: string, columns: string[], row: Record<string, unknown>): string {
  const cols = columns.map(quoteIdent).join(", ");
  const vals = columns.map((c) => quoteVal(row[c])).join(", ");
  return `INSERT INTO ${table} (${cols}) VALUES (${vals});`;
}

function pluralize(w: string): string {
  if (w.endsWith("y") && !/[aeiou]y$/.test(w)) return w.slice(0, -1) + "ies";
  if (/([sxz]|[cs]h)$/.test(w)) return w + "es";
  return w + "s";
}

function inferFkTable(col: string): string | null {
  if (col.toLowerCase() === "id") return null;
  const m = col.match(/^(.+?)_id$/i);
  return m ? pluralize(m[1].toLowerCase()) : null;
}

function DisplayValue({ value, type, onExpand }: { value: unknown; type: CellType; onExpand?: () => void }) {
  if (value === null || value === undefined) return <span className="null">NULL</span>;
  if (type === "boolean") {
    const b = value === true || value === "true";
    return <span className={`bool-badge bool-badge--${b}`}>{b ? "true" : "false"}</span>;
  }
  if (type === "json" || typeof value === "object")
    return (
      <button className="json-cell-btn" onClick={onExpand}>
        {JSON.stringify(value)}
      </button>
    );
  return <>{String(value)}</>;
}

function NullBtn({ onNullify }: { onNullify: () => void }) {
  return (
    <button
      type="button"
      className="null-btn"
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onNullify}
      title="Set to NULL"
    >
      <X size={10} />
    </button>
  );
}

function BoolSelect({ draft, nullable, onChange, onCommit, onCancel, onNullify }: {
  draft: string; nullable: boolean; onChange: (v: string) => void;
  onCommit: () => void; onCancel: () => void; onNullify: () => void;
}) {
  return (
    <select
      autoFocus
      className="cell-select"
      value={draft}
      onChange={(e) => e.target.value === "" ? onNullify() : onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }}
    >
      <option value="true">true</option>
      <option value="false">false</option>
      {nullable && <option value="">NULL</option>}
    </select>
  );
}

function EnumSelect({ draft, options, nullable, onChange, onCommit, onCancel, onNullify }: {
  draft: string; options: string[]; nullable: boolean; onChange: (v: string) => void;
  onCommit: () => void; onCancel: () => void; onNullify: () => void;
}) {
  return (
    <select
      autoFocus
      className="cell-select"
      value={draft}
      onChange={(e) => e.target.value === "" ? onNullify() : onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }}
    >
      {nullable && <option value="">NULL</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function DateInput({ draft, nullable, onChange, onCommit, onCancel, onNullify }: {
  draft: string; nullable: boolean; onChange: (v: string) => void;
  onCommit: () => void; onCancel: () => void; onNullify: () => void;
}) {
  const pickerRef = useRef<HTMLInputElement>(null);
  return (
    <div className="cell-input-datetime">
      <input
        autoFocus
        type="text"
        className="cell-input"
        value={draft}
        placeholder="YYYY-MM-DD"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onCommit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        onClick={(e) => e.stopPropagation()}
      />
      {nullable && draft !== "" && <NullBtn onNullify={onNullify} />}
      <button
        type="button"
        className="datetime-cal-btn"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (pickerRef.current as any)?.showPicker?.()}
        title="Pick date"
      >
        <Calendar size={11} />
      </button>
      <input
        ref={pickerRef}
        type="date"
        className="datetime-hidden"
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        tabIndex={-1}
      />
    </div>
  );
}

function DateTimeInput({ draft, nullable, onChange, onCommit, onCancel, onNullify }: {
  draft: string; nullable: boolean; onChange: (v: string) => void;
  onCommit: () => void; onCancel: () => void; onNullify: () => void;
}) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const pickerVal = draft.replace(" ", "T").slice(0, 16);
  return (
    <div className="cell-input-datetime">
      <input
        autoFocus
        type="text"
        className="cell-input"
        value={draft}
        placeholder="YYYY-MM-DD HH:MM:SS"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onCommit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        onClick={(e) => e.stopPropagation()}
      />
      {nullable && draft !== "" && <NullBtn onNullify={onNullify} />}
      <button
        type="button"
        className="datetime-cal-btn"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (pickerRef.current as any)?.showPicker?.()}
        title="Pick date & time"
      >
        <Calendar size={11} />
      </button>
      <input
        ref={pickerRef}
        type="datetime-local"
        className="datetime-hidden"
        value={pickerVal}
        onChange={(e) => onChange(e.target.value.replace("T", " ") + ":00")}
        tabIndex={-1}
      />
    </div>
  );
}

function TextInput({ type, draft, nullable, onChange, onCommit, onCancel, onNullify }: {
  type: CellType; draft: string; nullable: boolean; onChange: (v: string) => void;
  onCommit: () => void; onCancel: () => void; onNullify: () => void;
}) {
  if (!nullable || draft === "") {
    return (
      <input
        autoFocus
        type={type === "integer" || type === "float" ? "number" : "text"}
        step={type === "float" ? "any" : undefined}
        className="cell-input"
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onCommit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }
  return (
    <div className="cell-input-datetime">
      <input
        autoFocus
        type={type === "integer" || type === "float" ? "number" : "text"}
        step={type === "float" ? "any" : undefined}
        className="cell-input"
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onCommit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        onClick={(e) => e.stopPropagation()}
      />
      <NullBtn onNullify={onNullify} />
    </div>
  );
}

function FkPickerModal({
  tableName, result, loading, currentValue, onSelect, onClose,
}: {
  tableName: string; result: QueryResult | null; loading: boolean;
  currentValue: unknown; onSelect: (val: unknown) => void; onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const pkCol = result ? (findPkColumn(result.columns) ?? result.columns[0]) : null;

  const rows = useMemo(() => {
    if (!result) return [];
    if (!search.trim()) return result.rows;
    const q = search.toLowerCase();
    return result.rows.filter((row) =>
      row.some((v) => v !== null && String(v).toLowerCase().includes(q))
    );
  }, [result, search]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal fk-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Pick from <code>{tableName}</code></span>
          <div className="fk-picker-header-right">
            {result && (
              <span className="fk-picker-count">
                {rows.length}{rows.length !== result.rows.length ? ` / ${result.rows.length}` : ""} row{rows.length !== 1 ? "s" : ""}
              </span>
            )}
            <button className="modal-close" onClick={onClose}><X size={14} /></button>
          </div>
        </div>
        <div className="fk-picker-search">
          <Search size={12} className="fk-search-icon" />
          <input
            autoFocus
            className="fk-search-input"
            placeholder="Filter rows…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="fk-picker-body">
          {loading && (
            <div className="fk-picker-loading"><Loader2 size={16} className="spin" /> Loading {tableName}…</div>
          )}
          {!loading && !result && (
            <div className="fk-picker-loading">No data found</div>
          )}
          {!loading && result && rows.length === 0 && (
            <div className="fk-picker-loading">No rows match "{search}"</div>
          )}
          {result && rows.length > 0 && (
            <table className="result-table fk-picker-table">
              <thead>
                <tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const rowObj = Object.fromEntries(result.columns.map((c, ci) => [c, row[ci]]));
                  const pkVal = pkCol ? rowObj[pkCol] : row[0];
                  const isCurrent = pkVal !== null && String(pkVal) === String(currentValue);
                  return (
                    <tr
                      key={i}
                      className={`fk-row${isCurrent ? " fk-row--current" : ""}`}
                      onClick={() => onSelect(pkVal)}
                      title="Click to select"
                    >
                      {row.map((v, ci) => (
                        <td key={ci}>{v === null ? <span className="null">NULL</span> : String(v)}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function ColVisibilityPicker({ columns, hidden, onToggle, onShowAll, onClose }: {
  columns: string[];
  hidden: Set<string>;
  onToggle: (col: string) => void;
  onShowAll: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div className="col-vis-popover" ref={ref}>
      <div className="col-vis-header">
        <span>Columns</span>
        {hidden.size > 0 && (
          <button className="col-vis-showall" onClick={onShowAll}>Show all</button>
        )}
      </div>
      <div className="col-vis-list">
        {columns.map((col) => (
          <label key={col} className="col-vis-item">
            <input
              type="checkbox"
              checked={!hidden.has(col)}
              onChange={() => onToggle(col)}
            />
            <span>{col}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

async function exportCsv(result: QueryResult, visibleCols: string[]) {
  const e = (v: unknown) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const colIdxs = visibleCols.map((c) => result.columns.indexOf(c));
  await saveToFile(
    [
      visibleCols.map(e).join(","),
      ...result.rows.map((r) => colIdxs.map((i) => e(r[i])).join(",")),
    ].join("\n"),
    "results.csv",
  );
}

async function exportJson(result: QueryResult, visibleCols: string[]) {
  await saveToFile(
    JSON.stringify(
      result.rows.map((r) =>
        Object.fromEntries(visibleCols.map((c) => [c, r[result.columns.indexOf(c)]]))
      ),
      null, 2,
    ),
    "results.json",
  );
}

async function saveToFile(content: string, defaultName: string) {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  const path = await save({ defaultPath: defaultName });
  if (path) await writeTextFile(path, content);
}

type PendingEdits = Map<string, { val: string | null; type: CellType }>;

export function ResultTable({
  result, sql, isReadOnly, columnTypes, onSaveChanges, onFetchFkOptions,
  onLoadMore, canLoadMore, onRequery, filterResetToken,
}: Props) {
  const [pendingEdits, setPendingEdits] = useState<PendingEdits>(new Map());
  const [pendingDeletes, setPendingDeletes] = useState<Set<number>>(new Set());
  const [editingCell, setEditingCell] = useState<{ origIdx: number; col: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [fkPicker, setFkPicker] = useState<{
    origIdx: number; col: string; table: string; result: QueryResult | null; loading: boolean;
  } | null>(null);

  // Sort state
  const [sortConfig, setSortConfig] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);

  // Column visibility
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
  const [showColPicker, setShowColPicker] = useState(false);

  // Filter bar
  const [showFilterBar, setShowFilterBar] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});

  // Cell context menu
  const [cellCtx, setCellCtx] = useState<{ x: number; y: number; origIdx: number; col: string } | null>(null);

  // JSON expand modal
  const [expandedCell, setExpandedCell] = useState<unknown>(null);

  // Row selection
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set()); // keyed by origIdx
  const lastSelectedPosRef = useRef<number | null>(null); // position in sortedIndexed for shift-click


  const tableName = useMemo(
    () => (sql && !isReadOnly ? parseTableName(sql) : null),
    [sql, isReadOnly],
  );
  const isEditable = !!tableName && !!onSaveChanges && !isReadOnly;

  const data = useMemo(
    () => result.rows.map((row) => Object.fromEntries(result.columns.map((c, i) => [c, row[i]]))),
    [result],
  );

  const enumOptions = useMemo<Record<string, string[]>>(() => {
    const map: Record<string, string[]> = {};
    for (const col of result.columns) {
      const pgType = columnTypes?.[col]?.toLowerCase() ?? "";
      const isLikelyEnum = pgType && !PG_STD.test(pgType) && !PG_BOOL.test(pgType)
        && !PG_INT.test(pgType) && !PG_FLOAT.test(pgType)
        && !PG_DATE.test(pgType) && !PG_TS.test(pgType);
      if (!isLikelyEnum) continue;
      const vals = new Set<string>();
      for (const row of data) {
        const v = row[col];
        if (v !== null && v !== undefined) vals.add(String(v));
      }
      if (vals.size > 0 && vals.size <= 30) map[col] = Array.from(vals).sort();
    }
    return map;
  }, [result.columns, data, columnTypes]);

  const nullableColumns = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    for (const col of result.columns) {
      if (data.some((row) => row[col] === null || row[col] === undefined)) s.add(col);
    }
    return s;
  }, [result.columns, data]);

  const visibleCols = useMemo(
    () => result.columns.filter((c) => !hiddenCols.has(c)),
    [result.columns, hiddenCols],
  );

  const hasFilters = useMemo(() => Object.values(filters).some(Boolean), [filters]);

  const indexedData = useMemo(
    () => data.map((row, origIdx) => ({ row, origIdx })),
    [data],
  );

  const filteredIndexed = useMemo(() => {
    if (!hasFilters) return indexedData;
    return indexedData.filter(({ row }) =>
      Object.entries(filters).every(([col, f]) =>
        !f || String(row[col] ?? "").toLowerCase().includes(f.toLowerCase())
      )
    );
  }, [indexedData, filters, hasFilters]);

  const sortedIndexed = useMemo(() => {
    if (!sortConfig) return filteredIndexed;
    const { col, dir } = sortConfig;
    return [...filteredIndexed].sort(({ row: a }, { row: b }) => {
      const av = a[col], bv = b[col];
      if (av == null) return dir === "asc" ? 1 : -1;
      if (bv == null) return dir === "asc" ? -1 : 1;
      if (typeof av === "number" && typeof bv === "number") return dir === "asc" ? av - bv : bv - av;
      const cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
      return dir === "asc" ? cmp : -cmp;
    });
  }, [filteredIndexed, sortConfig]);

  // Reset editing/selection state whenever result changes
  useEffect(() => {
    setPendingEdits(new Map());
    setPendingDeletes(new Set());
    setEditingCell(null);
    setSelectedRows(new Set());
    lastSelectedPosRef.current = null;
  }, [result]);

  // Reset filter/sort only when a fresh user-initiated query fires (token increments)
  useEffect(() => {
    setSortConfig(null);
    setFilters({});
    setShowFilterBar(false);
    prevFiltersRef.current = {};
  }, [filterResetToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Server-side filter: debounce 450ms, only fires when filter VALUES actually change
  const prevFiltersRef = useRef<Record<string, string>>({});
  const onRequeryRef = useRef(onRequery);
  useEffect(() => { onRequeryRef.current = onRequery; });

  useEffect(() => {
    if (!onRequery) return;
    const hasFilters = Object.values(filters).some(Boolean);
    const prevFilters = prevFiltersRef.current;
    const hadFilters = Object.values(prevFilters).some(Boolean);

    const valuesChanged =
      Object.keys(filters).length !== Object.keys(prevFilters).length ||
      Object.entries(filters).some(([k, v]) => prevFilters[k] !== v);

    prevFiltersRef.current = filters;

    if (!valuesChanged) return;
    if (!hasFilters && !hadFilters) return;

    const timer = setTimeout(() => {
      onRequeryRef.current?.(filters);
    }, hasFilters ? 450 : 0);
    return () => clearTimeout(timer);
  }, [filters, onRequery]);

  function handleSort(col: string) {
    setSortConfig((prev) => {
      if (!prev || prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return null;
    });
  }

  function getCellType(col: string, origIdx: number): CellType {
    return detectType(data[origIdx]?.[col], columnTypes?.[col], enumOptions[col]);
  }

  function startEdit(origIdx: number, col: string) {
    if (pendingDeletes.has(origIdx)) return;
    const key = `${origIdx}\x00${col}`;
    const originalVal = data[origIdx][col];
    const type = getCellType(col, origIdx);
    const currentDraft = pendingEdits.has(key)
      ? (pendingEdits.get(key)!.val ?? "")
      : toDraft(originalVal, type);
    setDraft(currentDraft);
    setEditingCell({ origIdx, col });
  }

  function stageEdit(origIdx: number, col: string, newVal: string | null) {
    const key = `${origIdx}\x00${col}`;
    const originalVal = data[origIdx][col];
    const type = getCellType(col, origIdx);
    const originalStr = originalVal === null || originalVal === undefined ? null : String(originalVal);
    const normalised = newVal === "" ? null : newVal;
    setPendingEdits((prev) => {
      const next = new Map(prev);
      if (normalised === originalStr) next.delete(key);
      else next.set(key, { val: normalised, type });
      return next;
    });
  }

  function commitEdit() {
    if (!editingCell) return;
    stageEdit(editingCell.origIdx, editingCell.col, draft);
    setEditingCell(null);
  }

  function toggleDelete(origIdx: number) {
    if (editingCell?.origIdx === origIdx) setEditingCell(null);
    setPendingDeletes((prev) => {
      const next = new Set(prev);
      if (next.has(origIdx)) next.delete(origIdx); else next.add(origIdx);
      return next;
    });
  }

  function openFkPicker(origIdx: number, col: string, fkTable: string) {
    if (editingCell) {
      stageEdit(editingCell.origIdx, editingCell.col, draft);
      setEditingCell(null);
    }
    setFkPicker({ origIdx, col, table: fkTable, result: null, loading: true });
    onFetchFkOptions!(fkTable)
      .then((r) => setFkPicker((p) => p ? { ...p, result: r, loading: false } : null))
      .catch(() => setFkPicker((p) => p ? { ...p, loading: false } : null));
  }

  function selectFkValue(val: unknown) {
    if (!fkPicker) return;
    stageEdit(fkPicker.origIdx, fkPicker.col, val === null ? null : String(val));
    setFkPicker(null);
  }

  function discardAll() {
    setPendingEdits(new Map());
    setPendingDeletes(new Set());
    setEditingCell(null);
  }

  function saveAll() {
    if (!tableName || !onSaveChanges) return;
    const sqls: string[] = [];
    const editsByRow = new Map<number, { col: string; newVal: string | null; type: CellType }[]>();
    for (const [key, { val, type }] of pendingEdits) {
      const sep = key.indexOf("\x00");
      const origIdx = parseInt(key.slice(0, sep));
      const col = key.slice(sep + 1);
      if (pendingDeletes.has(origIdx)) continue;
      if (!editsByRow.has(origIdx)) editsByRow.set(origIdx, []);
      editsByRow.get(origIdx)!.push({ col, newVal: val, type });
    }
    for (const [origIdx, changes] of editsByRow)
      sqls.push(buildUpdateMulti(tableName, changes, result.columns, data[origIdx]));
    for (const origIdx of pendingDeletes)
      sqls.push(buildDelete(tableName, result.columns, data[origIdx]));
    onSaveChanges(sqls);
  }

  function toggleRowSelect(origIdx: number, pos: number, e: React.MouseEvent) {
    if (e.shiftKey && lastSelectedPosRef.current !== null) {
      const lo = Math.min(lastSelectedPosRef.current, pos);
      const hi = Math.max(lastSelectedPosRef.current, pos);
      setSelectedRows((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) next.add(sortedIndexed[i].origIdx);
        return next;
      });
      return;
    }
    lastSelectedPosRef.current = pos;
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(origIdx)) next.delete(origIdx); else next.add(origIdx);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedRows.size === sortedIndexed.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(sortedIndexed.map((r) => r.origIdx)));
    }
  }

  function buildCellCtxItems(origIdx: number, col: string): ContextMenuDef[] {
    const row = data[origIdx];
    const val = row[col];
    const items: ContextMenuDef[] = [
      {
        label: "Copy cell value",
        icon: <Copy size={12} />,
        onClick: () => navigator.clipboard.writeText(val == null ? "" : String(val)),
      },
      {
        label: "Copy row as JSON",
        icon: <Copy size={12} />,
        onClick: () => navigator.clipboard.writeText(JSON.stringify(row, null, 2)),
      },
    ];
    if (tableName) {
      items.push({
        label: "Copy row as INSERT",
        icon: <Copy size={12} />,
        onClick: () => navigator.clipboard.writeText(buildInsert(tableName, result.columns, row)),
      });
    }
    if (val !== null && val !== undefined) {
      items.push("separator");
      items.push({
        label: `Filter by "${String(val).slice(0, 24)}"`,
        icon: <Filter size={12} />,
        onClick: () => {
          setFilters((f) => ({ ...f, [col]: String(val) }));
          setShowFilterBar(true);
        },
      });
    }
    if (isEditable) {
      items.push("separator");
      items.push({
        label: "Edit cell",
        icon: <Pencil size={12} />,
        disabled: pendingDeletes.has(origIdx),
        onClick: () => startEdit(origIdx, col),
      });
      items.push({
        label: pendingDeletes.has(origIdx) ? "Undo delete" : "Delete row",
        icon: <Trash2 size={12} />,
        danger: !pendingDeletes.has(origIdx),
        onClick: () => toggleDelete(origIdx),
      });
    }
    return items;
  }

  const totalChanges = pendingEdits.size + pendingDeletes.size;
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  function renderEditInput(origIdx: number, col: string) {
    const type = getCellType(col, origIdx);
    const fkTable = onFetchFkOptions ? inferFkTable(col) : null;
    const cancel = () => setEditingCell(null);
    const nullable = nullableColumns.has(col);
    const nullify = () => { stageEdit(origIdx, col, null); setEditingCell(null); };

    const inputEl = (() => {
      if (type === "boolean") return <BoolSelect draft={draft} nullable={nullable} onChange={setDraft} onCommit={commitEdit} onCancel={cancel} onNullify={nullify} />;
      if (type === "enum") return <EnumSelect draft={draft} options={enumOptions[col] ?? []} nullable={nullable} onChange={setDraft} onCommit={commitEdit} onCancel={cancel} onNullify={nullify} />;
      if (type === "date") return <DateInput draft={draft} nullable={nullable} onChange={setDraft} onCommit={commitEdit} onCancel={cancel} onNullify={nullify} />;
      if (type === "datetime") return <DateTimeInput draft={draft} nullable={nullable} onChange={setDraft} onCommit={commitEdit} onCancel={cancel} onNullify={nullify} />;
      return <TextInput type={type} draft={draft} nullable={nullable} onChange={setDraft} onCommit={commitEdit} onCancel={cancel} onNullify={nullify} />;
    })();

    if (!fkTable) return inputEl;

    return (
      <div className="cell-input-fk">
        {inputEl}
        <button
          type="button"
          className="fk-pick-btn"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => openFkPicker(origIdx, col, fkTable)}
          title={`Pick from ${fkTable}`}
        >
          <ExternalLink size={11} />
        </button>
      </div>
    );
  }

  return (
    <div className="result-wrap">
      {/* ── Toolbar ── */}
      <div className="result-meta">
        <span className="result-row-count">
          {sortedIndexed.length !== data.length
            ? `${sortedIndexed.length} / ${data.length} rows`
            : `${data.length} row${data.length !== 1 ? "s" : ""}`
          }
          {sortConfig && (
            <span className="result-scope-badge" title="Sorted on loaded rows only">
              sorted: loaded rows
            </span>
          )}
        </span>

        {isEditable && totalChanges === 0 && (
          <span className="edit-hint">Double-click to edit · hover row to delete</span>
        )}
        {totalChanges > 0 && (
          <div className="staged-actions">
            <span className="staged-count">
              {pendingEdits.size > 0 && `${pendingEdits.size} edit${pendingEdits.size !== 1 ? "s" : ""}`}
              {pendingEdits.size > 0 && pendingDeletes.size > 0 && ", "}
              {pendingDeletes.size > 0 && `${pendingDeletes.size} deletion${pendingDeletes.size !== 1 ? "s" : ""}`}
            </span>
            <button className="staged-discard" onClick={discardAll}><Undo2 size={11} /> Discard</button>
            <button className="staged-save" onClick={saveAll}><Save size={11} /> Save</button>
          </div>
        )}

        <div className="result-toolbar-right">
          <button
            className={`toolbar-btn${showFilterBar ? " toolbar-btn--active" : ""}`}
            onClick={() => setShowFilterBar((v) => !v)}
            title="Toggle filter bar"
          >
            <Filter size={11} />
            {activeFilterCount > 0 && <span className="toolbar-badge">{activeFilterCount}</span>}
          </button>

          <div className="col-vis-wrap">
            <button
              className={`toolbar-btn${hiddenCols.size > 0 ? " toolbar-btn--active" : ""}`}
              onClick={() => setShowColPicker((v) => !v)}
              title="Show/hide columns"
            >
              <SlidersHorizontal size={11} />
              {hiddenCols.size > 0 && <span className="toolbar-badge">{hiddenCols.size}</span>}
              <ChevronDown size={10} />
            </button>
            {showColPicker && (
              <ColVisibilityPicker
                columns={result.columns}
                hidden={hiddenCols}
                onToggle={(col) => setHiddenCols((prev) => {
                  const next = new Set(prev);
                  if (next.has(col)) next.delete(col); else next.add(col);
                  return next;
                })}
                onShowAll={() => setHiddenCols(new Set())}
                onClose={() => setShowColPicker(false)}
              />
            )}
          </div>

          <div className="result-export">
            <button className="export-btn" onClick={() => void exportCsv(result, visibleCols)}><Download size={11} />CSV</button>
            <button className="export-btn" onClick={() => void exportJson(result, visibleCols)}><Download size={11} />JSON</button>
          </div>
        </div>
      </div>

      {/* ── Filter bar ── */}
      {showFilterBar && (
        <div className="filter-bar">
          <div className="filter-bar-spacer" />
          {visibleCols.map((col) => (
            <div key={col} className="filter-col-wrap">
              <input
                className="filter-col-input"
                placeholder={col}
                value={filters[col] ?? ""}
                onChange={(e) => setFilters((f) => ({ ...f, [col]: e.target.value }))}
              />
            </div>
          ))}
          {hasFilters && (
            <button className="filter-clear-btn" onClick={() => setFilters({})}>
              <X size={11} /> Clear
            </button>
          )}
        </div>
      )}

      {/* ── Table ── */}
      <div className="table-scroll">
        <table className="result-table">
          <thead>
            <tr>
              <th
                className="th-rownum"
                onClick={toggleSelectAll}
                title={selectedRows.size === sortedIndexed.length && sortedIndexed.length > 0 ? "Deselect all" : "Select all"}
              >
                {selectedRows.size > 0 && selectedRows.size < sortedIndexed.length
                  ? <span className="rownum-partial">—</span>
                  : selectedRows.size === sortedIndexed.length && sortedIndexed.length > 0
                    ? <span className="rownum-checked">✓</span>
                    : <span className="rownum-hash">#</span>
                }
              </th>
              {visibleCols.map((col) => {
                const isActive = sortConfig?.col === col;
                return (
                  <th
                    key={col}
                    className="th-sortable"
                    onClick={() => handleSort(col)}
                  >
                    <span className="th-inner">
                      <span>{col}</span>
                      {isActive
                        ? sortConfig!.dir === "asc"
                          ? <ArrowUp size={10} className="sort-icon sort-icon--active" />
                          : <ArrowDown size={10} className="sort-icon sort-icon--active" />
                        : <ArrowUpDown size={10} className="sort-icon sort-icon--dim" />
                      }
                    </span>
                  </th>
                );
              })}
              {isEditable && <th className="th-actions" />}
            </tr>
          </thead>
          <tbody>
            {sortedIndexed.map(({ row, origIdx }, pos) => {
              const isDeleted = pendingDeletes.has(origIdx);
              const rowHasEdit = !isDeleted && visibleCols.some((c) => pendingEdits.has(`${origIdx}\x00${c}`));
              const isSelected = selectedRows.has(origIdx);
              return (
                <tr
                  key={origIdx}
                  className={[
                    isEditable ? "tr-editable" : "",
                    isDeleted ? "tr-pending-delete" : "",
                    rowHasEdit ? "tr-has-edit" : "",
                    isSelected ? "tr-selected" : "",
                  ].filter(Boolean).join(" ") || undefined}
                >
                  <td
                    className={`td-rownum${isSelected ? " td-rownum--selected" : ""}`}
                    onClick={(e) => toggleRowSelect(origIdx, pos, e)}
                    title="Click to select row · Shift+click to select range"
                  >
                    <span className="rownum-val">{pos + 1}</span>
                  </td>
                  {visibleCols.map((col) => {
                    const key = `${origIdx}\x00${col}`;
                    const staged = pendingEdits.get(key);
                    const hasStagedEdit = !isDeleted && pendingEdits.has(key);
                    const isEditingThis = editingCell?.origIdx === origIdx && editingCell?.col === col;
                    const originalVal = row[col];
                    const type = getCellType(col, origIdx);

                    return (
                      <td
                        key={col}
                        className={hasStagedEdit ? "td-pending-edit" : undefined}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setCellCtx({ x: e.clientX, y: e.clientY, origIdx, col });
                        }}
                      >
                        {isEditingThis ? renderEditInput(origIdx, col) : (
                          <span
                            className={[
                              isEditable && !isDeleted ? "cell-editable" : "",
                              hasStagedEdit ? "cell-edited" : "",
                            ].filter(Boolean).join(" ") || undefined}
                            onDoubleClick={isEditable && !isDeleted ? () => startEdit(origIdx, col) : undefined}
                            title={hasStagedEdit ? `Original: ${originalVal ?? "NULL"}` : undefined}
                          >
                            <DisplayValue
                              value={hasStagedEdit ? staged!.val : originalVal}
                              type={type}
                              onExpand={() => setExpandedCell(hasStagedEdit ? staged!.val : originalVal)}
                            />
                          </span>
                        )}
                      </td>
                    );
                  })}
                  {isEditable && (
                    <td className="td-actions">
                      <button
                        className={`row-delete-btn${isDeleted ? " row-delete-btn--staged" : ""}`}
                        onClick={() => toggleDelete(origIdx)}
                        title={isDeleted ? "Undo delete" : "Delete row"}
                      >
                        {isDeleted ? <Undo2 size={11} /> : <Trash2 size={11} />}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Pagination footer ── */}
      {canLoadMore && onLoadMore && (
        <div className="result-footer">
          <button className="load-more-btn" onClick={onLoadMore}>
            Load 100 more rows
          </button>
        </div>
      )}

      {/* ── Cell context menu ── */}
      {cellCtx && (
        <ContextMenu
          x={cellCtx.x}
          y={cellCtx.y}
          items={buildCellCtxItems(cellCtx.origIdx, cellCtx.col)}
          onClose={() => setCellCtx(null)}
        />
      )}

      {fkPicker && (
        <FkPickerModal
          tableName={fkPicker.table}
          result={fkPicker.result}
          loading={fkPicker.loading}
          currentValue={data[fkPicker.origIdx][fkPicker.col]}
          onSelect={selectFkValue}
          onClose={() => setFkPicker(null)}
        />
      )}

      {expandedCell !== null && (
        <div className="modal-overlay" onClick={() => setExpandedCell(null)}>
          <div className="modal json-expand-modal" onClick={(e) => e.stopPropagation()}>
            <div className="json-expand-header">
              <span>JSON</span>
              <button onClick={() => setExpandedCell(null)}>✕</button>
            </div>
            <pre className="json-expand-body">{JSON.stringify(expandedCell, null, 2)}</pre>
            <div className="json-expand-actions">
              <button
                className="json-expand-copy"
                onClick={() => navigator.clipboard.writeText(JSON.stringify(expandedCell, null, 2))}
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
