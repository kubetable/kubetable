import { Copy, Key, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { QueryResult, SchemaNode } from "../lib/tauri";

interface ColumnDetail {
  pos: number;
  name: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  default: string | null;
  maxLen: number | null;
  precision: number | null;
  scale: number | null;
  isPk: boolean;
}

interface IndexDetail {
  name: string;
  def: string;
  isUnique: boolean;
  isPrimary: boolean;
}

interface Stats {
  rowCount: string;
  totalSize: string;
  dataSize: string;
}

function col(result: QueryResult, row: unknown[], name: string): string | null {
  const i = result.columns.indexOf(name);
  return i >= 0 && row[i] != null ? String(row[i]) : null;
}

interface Props {
  table: SchemaNode;
  schemaName: string;
  onClose: () => void;
  onQuery?: (sql: string) => Promise<QueryResult>;
}

export function TableDetailModal({ table, schemaName, onClose, onQuery }: Props) {
  const [columns, setColumns]   = useState<ColumnDetail[] | null>(null);
  const [indexes, setIndexes]   = useState<IndexDetail[] | null>(null);
  const [stats, setStats]       = useState<Stats | null>(null);
  const [error, setError]       = useState<string | null>(null);

  const qualified = schemaName ? `"${schemaName}"."${table.name}"` : `"${table.name}"`;


  useEffect(() => {
    if (!onQuery) return;
    let cancelled = false;

    async function load() {
      try {
        const [colsR, pkR, idxR, statsR] = await Promise.allSettled([
          onQuery!(`
            SELECT ordinal_position, column_name, data_type, udt_name,
                   is_nullable, column_default,
                   character_maximum_length, numeric_precision, numeric_scale
            FROM information_schema.columns
            WHERE table_schema = '${schemaName}' AND table_name = '${table.name}'
            ORDER BY ordinal_position
          `),
          onQuery!(`
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
             AND tc.table_name = kcu.table_name
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = '${schemaName}'
              AND tc.table_name = '${table.name}'
          `),
          onQuery!(`
            SELECT indexname, indexdef,
                   indexdef ILIKE '%unique%' OR indexname ILIKE 'u%' AS is_unique_hint
            FROM pg_indexes
            WHERE schemaname = '${schemaName}' AND tablename = '${table.name}'
            ORDER BY indexname
          `),
          onQuery!(`
            SELECT
              pg_size_pretty(pg_total_relation_size('${qualified.replace(/'/g, "''")}')) AS total_size,
              pg_size_pretty(pg_relation_size('${qualified.replace(/'/g, "''")}')) AS data_size,
              (SELECT COUNT(*)::text FROM ${qualified}) AS row_count
          `),
        ]);

        if (cancelled) return;

        const pkSet = new Set<string>();
        if (pkR.status === "fulfilled") {
          for (const row of pkR.value.rows) {
            const v = col(pkR.value, row, "column_name");
            if (v) pkSet.add(v);
          }
        }

        if (colsR.status === "fulfilled") {
          setColumns(colsR.value.rows.map((row) => ({
            pos:      Number(col(colsR.value, row, "ordinal_position") ?? 0),
            name:     col(colsR.value, row, "column_name") ?? "",
            dataType: col(colsR.value, row, "data_type") ?? "",
            udtName:  col(colsR.value, row, "udt_name") ?? "",
            nullable: col(colsR.value, row, "is_nullable") === "YES",
            default:  col(colsR.value, row, "column_default"),
            maxLen:   col(colsR.value, row, "character_maximum_length") != null
                        ? Number(col(colsR.value, row, "character_maximum_length")) : null,
            precision: col(colsR.value, row, "numeric_precision") != null
                        ? Number(col(colsR.value, row, "numeric_precision")) : null,
            scale:     col(colsR.value, row, "numeric_scale") != null
                        ? Number(col(colsR.value, row, "numeric_scale")) : null,
            isPk:     pkSet.has(col(colsR.value, row, "column_name") ?? ""),
          })));
        } else {
          setError("Could not load column details");
        }

        if (idxR.status === "fulfilled") {
          setIndexes(idxR.value.rows.map((row) => {
            const def = col(idxR.value, row, "indexdef") ?? "";
            return {
              name:      col(idxR.value, row, "indexname") ?? "",
              def,
              isUnique:  def.toUpperCase().includes("UNIQUE"),
              isPrimary: def.toUpperCase().includes("PRIMARY"),
            };
          }));
        }

        if (statsR.status === "fulfilled" && statsR.value.rows.length > 0) {
          const r = statsR.value.rows[0];
          setStats({
            rowCount:  col(statsR.value, r, "row_count") ?? "—",
            totalSize: col(statsR.value, r, "total_size") ?? "—",
            dataSize:  col(statsR.value, r, "data_size") ?? "—",
          });
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }

    load();
    return () => { cancelled = true; };
  }, [table.name, schemaName]);

  function copyColumns() {
    const lines = (columns ?? []).map((c) => `${c.name}: ${c.dataType}${c.nullable ? "" : " NOT NULL"}`);
    navigator.clipboard.writeText(lines.join("\n"));
  }

  function copySelect() {
    navigator.clipboard.writeText(`SELECT *\nFROM ${qualified}\nLIMIT 100;`);
  }

  function copyInsert() {
    const cols = (columns ?? []).map((c) => `"${c.name}"`).join(", ");
    const vals = (columns ?? []).map((c) => sqlPlaceholder(c.dataType)).join(", ");
    navigator.clipboard.writeText(`INSERT INTO ${qualified} (${cols})\nVALUES (${vals});`);
  }

  const loading = !columns && !error;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal table-detail-modal" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="modal-header">
          <span className="modal-title">
            {schemaName && <span className="td-schema-prefix">{schemaName}.</span>}
            {table.name}
          </span>
          <div className="fk-picker-header-right">
            {columns && <span className="fk-picker-count">{columns.length} columns</span>}
            <button className="modal-close" onClick={onClose}><X size={14} /></button>
          </div>
        </div>

        {/* Stats bar */}
        {(stats || loading) && (
          <div className="td-stats-bar">
            {loading ? (
              <span className="td-stat-item"><Loader2 size={11} className="spin" /> Loading…</span>
            ) : stats ? (
              <>
                <span className="td-stat-item">
                  <span className="td-stat-label">Rows</span>
                  <span className="td-stat-value">{Number(stats.rowCount).toLocaleString()}</span>
                </span>
                <span className="td-stat-sep" />
                <span className="td-stat-item">
                  <span className="td-stat-label">Total size</span>
                  <span className="td-stat-value">{stats.totalSize}</span>
                </span>
                <span className="td-stat-sep" />
                <span className="td-stat-item">
                  <span className="td-stat-label">Data</span>
                  <span className="td-stat-value">{stats.dataSize}</span>
                </span>
              </>
            ) : null}
          </div>
        )}

        {/* Body */}
        <div className="table-detail-body">
          {error && <div className="td-error">{error}</div>}

          {loading && !error && (
            <div className="td-loading">
              <Loader2 size={18} className="spin" />
              <span>Loading table details…</span>
            </div>
          )}

          {columns && (
            <table className="table-detail-table">
              <thead>
                <tr>
                  <th className="td-pos-th">#</th>
                  <th className="td-pk-th" title="Primary key" />
                  <th>Column</th>
                  <th>Type</th>
                  <th>Nullable</th>
                  <th>Default</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((c) => (
                  <tr key={c.name} className={c.isPk ? "td-row-pk" : ""}>
                    <td className="td-pos-cell">{c.pos}</td>
                    <td className="td-pk-cell">
                      {c.isPk && <Key size={10} className="td-pk-icon" />}
                    </td>
                    <td className="td-col-name">{c.name}</td>
                    <td className="td-col-type">
                      {formatType(c)}
                    </td>
                    <td className="td-col-nullable">
                      {c.nullable
                        ? <span className="td-badge td-badge--null">NULL</span>
                        : <span className="td-badge td-badge--notnull">NOT NULL</span>
                      }
                    </td>
                    <td className="td-col-default">
                      {c.default ? <code className="td-default-val">{c.default}</code> : <span className="td-none">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Indexes section */}
          {indexes && indexes.length > 0 && (
            <div className="td-indexes">
              <div className="td-section-header">Indexes</div>
              {indexes.map((idx) => (
                <div key={idx.name} className="td-index-row">
                  <div className="td-index-name">
                    {idx.isPrimary && <span className="td-badge td-badge--pk">PK</span>}
                    {idx.isUnique && !idx.isPrimary && <span className="td-badge td-badge--unique">UNIQUE</span>}
                    {idx.name}
                  </div>
                  <div className="td-index-def">{idx.def}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="table-detail-footer">
          <button className="td-copy-btn" onClick={copyColumns} title="Copy column list">
            <Copy size={11} /> Columns
          </button>
          <button className="td-copy-btn" onClick={copySelect} title="Copy SELECT">
            <Copy size={11} /> SELECT
          </button>
          <button className="td-copy-btn" onClick={copyInsert} title="Copy INSERT template">
            <Copy size={11} /> INSERT
          </button>
        </div>
      </div>
    </div>
  );
}

function formatType(c: ColumnDetail): string {
  const base = c.udtName !== c.dataType ? c.udtName : c.dataType;
  if (c.maxLen != null) return `${base}(${c.maxLen})`;
  if (c.precision != null && c.scale != null && c.scale > 0) return `${base}(${c.precision},${c.scale})`;
  if (c.precision != null) return `${base}(${c.precision})`;
  return base;
}

function sqlPlaceholder(type: string): string {
  const t = type.toLowerCase();
  if (/^(int|integer|bigint|smallint|serial)/.test(t)) return "0";
  if (/^(numeric|decimal|real|double|float|money)/.test(t)) return "0";
  if (/^bool/.test(t)) return "false";
  if (/^uuid/.test(t)) return "gen_random_uuid()";
  if (/^timestamp/.test(t)) return "NOW()";
  if (/^date/.test(t)) return "CURRENT_DATE";
  return "''";
}
