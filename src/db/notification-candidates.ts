import type { QueryableDatabase } from "./types.js";
import type { NotificationListing } from "./product-search-repository.js";
import type { NotificationEvent } from "../notifications/policy.js";

export interface NotificationCursor {
  at: string;
  id: number;
}
/** The existing active-updated index includes new inserts even when source publication is old.
 * The caller retains the cursor and revisits an overlap to recover delayed projections/commits. */
export async function notificationCandidates(
  db: QueryableDatabase,
  cursor: NotificationCursor,
  until: string,
) {
  const result = await db
    .prepare(`SELECT id, last_changed_at AS at FROM products INDEXED BY idx_products_active_updated
    WHERE is_active = 1 AND (last_changed_at, id) > (?, ?) AND last_changed_at <= ?
    ORDER BY last_changed_at, id LIMIT 20`)
    .bind(cursor.at, cursor.id, until)
    .all<NotificationCursor>();
  return result.results ?? [];
}
export function notificationEvents(rows: NotificationListing[]): NotificationEvent[] {
  return rows.flatMap((row) => {
    const common = {
      listingId: row.id,
      price: row.price_yen,
      title: `${row.manufacturer} ${row.model}`.trim().slice(0, 100),
      key: row.product_key,
    };
    const events: NotificationEvent[] = [
      { ...common, kind: "new", id: `new:${row.id}`, at: Date.parse(row.first_seen_at) },
    ];
    if (
      row.price_yen !== null &&
      row.previous_price_yen !== null &&
      row.price_yen < row.previous_price_yen &&
      row.price_observed_at
    ) {
      const at = Date.parse(row.price_observed_at);
      events.push({ ...common, kind: "drop", at, id: `drop:${row.id}:${at}:${row.price_yen}` });
    }
    return events.filter((event) => Number.isFinite(event.at));
  });
}
