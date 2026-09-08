import type { QueryableDatabase } from "./types.js";

export const ADMIN_HISTORY_STATE_SQL = {
  listing: `SELECT json_object('manufacturer_id', p.canonical_manufacturer_id, 'model', p.model,
    'primary_category_id', p.primary_category_id, 'presentation_color', p.presentation_color) AS values_json,
    COALESCE(o.updated_at, '') AS updated_at
    FROM products p LEFT JOIN product_admin_overrides o ON o.listing_product_id = p.id WHERE p.id = ?`,
  catalog: `SELECT json_object('manufacturer_id', p.manufacturer_id, 'canonical_model', p.canonical_model,
    'canonical_name', p.canonical_name, 'lifecycle_status', p.lifecycle_status,
    'primary_category_id', COALESCE((SELECT category_id FROM knowledge_catalog_product_categories
      WHERE product_id = p.id AND is_primary = 1 LIMIT 1), '')) AS values_json,
    p.updated_at, p.last_reviewed_at AS decision_at FROM knowledge_catalog_products p WHERE p.id = ?`,
} as const;

export function adminHistoryGuardStatement(
  db: QueryableDatabase,
  kind: "listing" | "catalog",
  id: number,
  valuesJson: string,
  updatedAt: string,
) {
  return db
    .prepare(`SELECT json(CASE WHEN EXISTS (SELECT 1 FROM (${ADMIN_HISTORY_STATE_SQL[kind]})
    WHERE values_json = ? AND updated_at = ?) THEN 'true' ELSE 'admin_history_conflict' END)`)
    .bind(id, valuesJson, updatedAt);
}

/** Called in the same transaction as an actual editor change; CSV reuses its own receipt. */
export function adminChangeJournalStatement(
  db: QueryableDatabase,
  kind: "listing" | "catalog",
  id: number,
  before: Record<string, string>,
  after: Record<string, string>,
  now: string,
  operationId: string = crypto.randomUUID(),
  restoredFrom = "",
): D1PreparedStatement[] {
  if (Object.keys(after).every((field) => before[field] === after[field])) return [];
  return [
    db
      .prepare(`INSERT INTO admin_product_change_log
    (operation_id, target_kind, target_id, before_json, after_json, created_at, restored_from)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        operationId,
        kind,
        id,
        JSON.stringify(before),
        JSON.stringify(after),
        now,
        restoredFrom,
      ),
  ];
}
