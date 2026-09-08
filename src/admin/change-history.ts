import { ADMIN_CSV_FIELDS, type AdminCsvChange } from "../api/admin-csv-contracts.js";
import type { AdminRestoreSelection } from "../api/admin-listing-contracts.js";
import { isRecord } from "../types.js";
import { previewAdminCsvChange } from "../db/admin-csv-import-repository.js";
import {
  hasLaterAdminChange,
  readAdminRestoreHistory,
} from "../db/admin-change-history-repository.js";
import {
  ADMIN_HISTORY_STATE_SQL,
  adminChangeJournalStatement,
  adminHistoryGuardStatement,
} from "../db/admin-change-journal.js";
import { updateListingAdminProduct } from "../db/listing-admin-repository.js";
import { refreshListingProjections } from "../db/listing-projection-refresh.js";
import { parseListingAdminUpdate } from "../http/listing-admin.js";
import type { QueryableDatabase, ReadableDatabase } from "../db/types.js";

export function parseAdminRestoreSelection(value: unknown): AdminRestoreSelection | null {
  if (
    !isRecord(value) ||
    (value.kind !== "listing" && value.kind !== "catalog") ||
    !Number.isSafeInteger(value.targetId) ||
    Number(value.targetId) < 1 ||
    (value.source !== "editor" && value.source !== "csv") ||
    typeof value.operationId !== "string" ||
    !/^[\da-f-]{36}$/iu.test(value.operationId) ||
    typeof value.field !== "string" ||
    Object.keys(value).some(
      (k) => !["kind", "targetId", "source", "operationId", "field"].includes(k),
    )
  )
    return null;
  const fields: readonly string[] =
    value.kind === "listing"
      ? [...ADMIN_CSV_FIELDS.listing, "presentation_color"]
      : ADMIN_CSV_FIELDS.catalog;
  return fields.includes(value.field) ? (value as unknown as AdminRestoreSelection) : null;
}

async function revision(state: { values_json: string; updated_at: string }) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(state)),
  );
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function previewAdminHistoryRestore(
  db: ReadableDatabase,
  selection: AdminRestoreSelection,
) {
  const history = await readAdminRestoreHistory(db, selection);
  const state = await db
    .prepare(ADMIN_HISTORY_STATE_SQL[selection.kind])
    .bind(selection.targetId)
    .first<{ values_json: string; updated_at: string; decision_at?: string | null }>();
  if (!history || !state || !Object.hasOwn(history.before, selection.field))
    return { status: "invalid" as const, message: "復元できる変更前の値がありません。" };
  const current = JSON.parse(state.values_json) as Record<string, string>;
  if (
    history.status === "pending" ||
    (selection.kind === "catalog" ? state.decision_at : state.updated_at) !== history.createdAt ||
    current[selection.field] !== history.after[selection.field] ||
    (await hasLaterAdminChange(db, history))
  )
    return {
      status: "conflict" as const,
      message: "後続の変更または未完了の反映があります。最新の内容を確認してください。",
    };
  if (history.before[selection.field] === history.after[selection.field])
    return { status: "invalid" as const, message: "この項目は変更されていません。" };
  if (selection.field === "presentation_color") {
    const value = history.before[selection.field];
    if (!parseListingAdminUpdate({ presentationColor: value }))
      return { status: "invalid" as const, message: "以前の色は現在の入力規則で使用できません。" };
    return {
      status: "ready" as const,
      message: "色を以前の値へ戻せます。",
      before: current[selection.field],
      after: value,
      revision: await revision(state),
    };
  }
  const fields = ADMIN_CSV_FIELDS[selection.kind];
  const original = Object.fromEntries(fields.map((field) => [field, current[field]]));
  const change: AdminCsvChange = {
    line: 1,
    original: { version: 1, kind: selection.kind, id: selection.targetId, values: original },
    values: { ...original, [selection.field]: history.before[selection.field] },
  };
  const result = await previewAdminCsvChange(db, change);
  return {
    ...result,
    change,
    before: current[selection.field],
    after: history.before[selection.field],
  };
}

export async function restoreAdminHistoryColor(
  db: QueryableDatabase,
  selection: AdminRestoreSelection,
  expectedRevision: string,
  operationId: string,
) {
  if (
    selection.kind !== "listing" ||
    selection.field !== "presentation_color" ||
    !/^[\da-f-]{36}$/iu.test(operationId) ||
    !/^[\da-f]{64}$/iu.test(expectedRevision)
  )
    throw new Error("invalid_history_restore");
  const source = `${selection.source}:${selection.operationId}:${selection.field}`;
  const receipt = await db
    .prepare("SELECT target_id, restored_from FROM admin_product_change_log WHERE operation_id = ?")
    .bind(operationId)
    .first<{ target_id: number; restored_from: string }>();
  if (receipt) {
    if (receipt.target_id !== selection.targetId || receipt.restored_from !== source)
      throw new Error("invalid_history_restore");
    // A lost response replays only pending projections, without rewriting the restored value.
    const listing = await db
      .prepare(
        "SELECT id, shop_key, source_id, remediation_projection_token AS token FROM products WHERE id = ? AND remediation_projection_required = 1",
      )
      .bind(selection.targetId)
      .first<{ id: number; shop_key: string; source_id: string; token: string }>();
    if (listing) {
      await refreshListingProjections(db, [listing], new Date().toISOString());
      await db
        .prepare(
          "UPDATE products SET remediation_projection_required = 0, remediation_projection_token = '' WHERE id = ? AND remediation_projection_token = ?",
        )
        .bind(listing.id, listing.token)
        .run();
    }
    return { status: "applied", message: "復元を反映しました。" };
  }
  const preview = await previewAdminHistoryRestore(db, selection);
  if (preview.status !== "ready" || preview.revision !== expectedRevision)
    return { status: "conflict", message: "変更されています。差分を再確認してください。" };
  const state = await db
    .prepare(ADMIN_HISTORY_STATE_SQL.listing)
    .bind(selection.targetId)
    .first<{ values_json: string; updated_at: string }>();
  if (!state || (await revision(state)) !== expectedRevision)
    return { status: "conflict", message: "変更されています。差分を再確認してください。" };
  const before = JSON.parse(state.values_json) as Record<string, string>;
  const after = { ...before, presentation_color: preview.after! };
  const now = new Date().toISOString();
  await updateListingAdminProduct(
    db,
    selection.targetId,
    { presentationColor: after.presentation_color },
    now,
    [
      adminHistoryGuardStatement(
        db,
        "listing",
        selection.targetId,
        state.values_json,
        state.updated_at,
      ),
      ...adminChangeJournalStatement(
        db,
        "listing",
        selection.targetId,
        before,
        after,
        now,
        operationId,
        source,
      ),
    ],
  );
  return { status: "applied", message: "色を復元しました。" };
}
