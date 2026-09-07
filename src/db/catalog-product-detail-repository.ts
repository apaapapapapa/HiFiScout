import { categoryClosureIds, getCategory } from "../catalog/categories.js";
import type { ProductSearchItem } from "../api/contracts.js";
import { firstMeasured } from "./read-accounting.js";
import type { ReadableDatabase } from "./types.js";

/** Verified catalog identity remains linkable when its transient offer projection is absent. */
export async function catalogProductWithoutOffers(db: ReadableDatabase, id: number): Promise<ProductSearchItem | null> {
  const row = await firstMeasured<{ manufacturer_id: string; manufacturer: string; model: string; category_id: string | null }>(db.prepare(`
    SELECT p.manufacturer_id,COALESCE(m.canonical_name,p.manufacturer_id) AS manufacturer,p.canonical_model AS model,
      (SELECT category_id FROM knowledge_catalog_product_categories WHERE product_id=p.id AND is_primary=1 LIMIT 1) AS category_id
    FROM knowledge_catalog_products p LEFT JOIN knowledge_catalog_manufacturers m ON m.id=p.manufacturer_id
    WHERE p.id=? AND p.verification_status='verified'`).bind(id));
  if (!row) return null;
  const categoryId = row.category_id || "unclassified";
  return { key: `c-${id}`, identity_kind: "catalog", catalog_product_id: id, manufacturer: row.manufacturer, manufacturer_id: row.manufacturer_id, model: row.model,
    primary_category_id: categoryId, category_ids: categoryClosureIds(categoryId), category: getCategory(categoryId)?.name || "",
    presentation_colors: [], offer_count: 0, in_stock_offer_count: 0, sold_out_offer_count: 0, shop_count: 0,
    lowest_price_yen: null, highest_price_yen: null, latest_activity_at: null, newest_listed_at: null, has_new_offer: false, has_price_drop: false, representative_offer: null };
}
