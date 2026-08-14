/**
 * `/api/products/:id/history`: one listing plus its recorded price points.
 *
 * Split from the search repository because it is a point read with different indexes and a
 * different response contract, and from the write repository because it never mutates.
 */

import type { ProductHistoryResponse } from "../api/contracts.js";
import { productColumns, toProductListItem } from "./product-row-mapper.js";
import type { PriceHistoryPoint, ProductRow, QueryableDatabase } from "./types.js";

/** Returns `null` for an unknown id so the caller can answer 404 without a second query. */
export async function productHistory(
  db: QueryableDatabase,
  id: number,
): Promise<ProductHistoryResponse | null> {
  const product = await db
    .prepare(`SELECT ${productColumns("p")} FROM products p WHERE p.id = ?`)
    .bind(id)
    .first<ProductRow>();
  if (!product) return null;
  const history = await db
    .prepare(
      "SELECT price_yen, observed_at FROM price_history WHERE product_id = ? ORDER BY observed_at ASC",
    )
    .bind(id)
    .all<PriceHistoryPoint>();
  return { product: toProductListItem(product), history: history.results || [] };
}
