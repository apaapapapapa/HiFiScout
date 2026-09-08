import type {
  AdminChangeHistory,
  AdminChangeHistoryItem,
  AdminRestoreSelection,
} from "../api/admin-listing-contracts.js";
import type { ReadableDatabase } from "./types.js";

interface HistoryRow {
  operation_id: string;
  before_json: string;
  after_json: string;
  created_at: string;
  status: string;
}

function item(
  row: HistoryRow,
  kind: "listing" | "catalog",
  targetId: number,
  source: "editor" | "csv",
): AdminChangeHistoryItem {
  const before = JSON.parse(row.before_json) as Record<string, unknown>;
  return {
    operationId: row.operation_id,
    kind,
    targetId,
    source,
    before: (source === "csv" ? (before.values ?? {}) : before) as Record<string, string>,
    after: JSON.parse(row.after_json) as Record<string, string>,
    createdAt: row.created_at,
    status: row.status,
  };
}

export async function readAdminChangeHistory(
  db: ReadableDatabase,
  kind: "listing" | "catalog",
  id: number,
): Promise<AdminChangeHistory> {
  const items: AdminChangeHistoryItem[] = [];
  for (const source of ["editor", "csv"] as const) {
    const table = source === "editor" ? "admin_product_change_log" : "admin_csv_import_changes";
    const rows = await db
      .prepare(`SELECT operation_id, before_json, after_json, created_at,
      ${source === "editor" ? "'saved'" : "status"} AS status FROM ${table}
      WHERE target_kind = ? AND target_id = ? ORDER BY created_at DESC, operation_id DESC LIMIT 26`)
      .bind(kind, id)
      .all<HistoryRow>();
    items.push(...(rows.results ?? []).map((row) => item(row, kind, id, source)));
  }
  if (kind === "listing") {
    const rows = await db
      .prepare(`SELECT id, field, previous_value, new_value, reason, processed_at
      FROM data_quality_remediation_events WHERE listing_product_id = ?
      ORDER BY processed_at DESC LIMIT 26`)
      .bind(id)
      .all<{
        id: number;
        field: string;
        previous_value: string;
        new_value: string;
        reason: string;
        processed_at: string;
      }>();
    for (const row of rows.results ?? [])
      items.push({
        operationId: String(row.id),
        kind,
        targetId: id,
        source: "resolver",
        before: { [row.field]: row.previous_value },
        after: { [row.field]: row.new_value },
        createdAt: row.processed_at,
        status: row.reason,
      });
  }
  items.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.operationId.localeCompare(a.operationId),
  );
  return { items: items.slice(0, 25), hasMore: items.length > 25 };
}

export async function readAdminRestoreHistory(
  db: ReadableDatabase,
  selection: AdminRestoreSelection,
) {
  const table =
    selection.source === "editor" ? "admin_product_change_log" : "admin_csv_import_changes";
  const row = await db
    .prepare(`SELECT operation_id, before_json, after_json, created_at,
    ${selection.source === "editor" ? "'saved'" : "status"} AS status FROM ${table}
    WHERE operation_id = ? AND target_kind = ? AND target_id = ?`)
    .bind(selection.operationId, selection.kind, selection.targetId)
    .first<HistoryRow>();
  return row ? item(row, selection.kind, selection.targetId, selection.source) : null;
}

/** Indexed seeks detect later edits, including same-value ABA cycles and equal timestamps. */
export async function hasLaterAdminChange(db: ReadableDatabase, history: AdminChangeHistoryItem) {
  for (const source of ["editor", "csv"] as const) {
    const table = source === "editor" ? "admin_product_change_log" : "admin_csv_import_changes";
    const newer = await db
      .prepare(`SELECT 1 AS found FROM ${table}
      WHERE target_kind = ? AND target_id = ? AND created_at >= ?
        AND (? <> ? OR operation_id <> ?) LIMIT 1`)
      .bind(
        history.kind,
        history.targetId,
        history.createdAt,
        source,
        history.source,
        history.operationId,
      )
      .first();
    if (newer) return true;
  }
  return false;
}
