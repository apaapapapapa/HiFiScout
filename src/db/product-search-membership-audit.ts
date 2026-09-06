import { syncProductSearchEntities } from "./product-search-entity-repository.js";
import { firstMeasured } from "./read-accounting.js";
import type { QueryableDatabase } from "./types.js";

/** Daily safety net for old memberships without a projection obligation. Normal cleanup consumes
 * current pending work; this audit resumes through memberships, not retained inactive products. */
export async function auditInactiveSearchMemberships(
  db: QueryableDatabase,
  { scanLimit = 100, repairLimit = 20 }: { scanLimit?: number; repairLimit?: number } = {},
) {
  if (
    !Number.isSafeInteger(scanLimit) ||
    scanLimit < 1 ||
    scanLimit > 500 ||
    !Number.isSafeInteger(repairLimit) ||
    repairLimit < 1 ||
    repairLimit > 100
  ) {
    throw new Error("Invalid membership audit budget");
  }
  const phase = "inactive-memberships";
  const cursor = await firstMeasured<{ after_id: number }>(
    db.prepare("SELECT after_id FROM product_projection_audit_cursors WHERE phase = ?").bind(phase),
  );
  const afterId = Number(cursor?.after_id || 0);
  const result = await db
    .prepare(`WITH candidates AS MATERIALIZED (
      SELECT listing_product_id FROM product_search_entity_offers
      WHERE listing_product_id > ? ORDER BY listing_product_id LIMIT ?
    ) SELECT p.id,p.shop_key,p.source_id,p.is_active
    FROM candidates c CROSS JOIN products p ON p.id=c.listing_product_id
    ORDER BY c.listing_product_id`)
    .bind(afterId, scanLimit)
    .all<{ id: number; shop_key: string; source_id: string; is_active: number }>();
  const rows = result.results || [];
  const gaps = rows.filter((row) => !row.is_active).slice(0, repairLimit);
  const shops = new Map<string, typeof gaps>();
  for (const gap of gaps) {
    const group = shops.get(gap.shop_key) || [];
    group.push(gap);
    shops.set(gap.shop_key, group);
  }
  for (const [shop, group] of shops) {
    await syncProductSearchEntities(
      db,
      shop,
      group.map((row) => row.source_id),
    );
    // Point lookups also keep verification bounded when stale statistics would scan an IN list.
    const remaining = await db.batch(
      group.map((row) =>
        db
          .prepare(`SELECT m.listing_product_id
      FROM product_search_entity_offers m CROSS JOIN products p ON p.id=m.listing_product_id
      WHERE m.listing_product_id = ? AND p.is_active=0`)
          .bind(row.id),
      ),
    );
    if (remaining.some((result) => result.results?.length))
      throw new Error("Inactive membership repair did not converge");
  }
  const moreGaps = rows.filter((row) => !row.is_active).length > gaps.length;
  const nextId = moreGaps ? gaps.at(-1)!.id : rows.length < scanLimit ? 0 : rows.at(-1)!.id;
  // No checkpoint crosses an unprocessed gap, including a budget exception during sync.
  if (nextId !== afterId) {
    await db
      .prepare(`INSERT INTO product_projection_audit_cursors(phase,after_id) VALUES (?,?)
      ON CONFLICT(phase) DO UPDATE SET after_id=excluded.after_id
      WHERE product_projection_audit_cursors.after_id=?`)
      .bind(phase, nextId, afterId)
      .run();
  }
  return { scannedCount: rows.length, repairedCount: gaps.length, nextAfterId: nextId };
}
