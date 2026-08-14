/**
 * `/api/meta`: the shop, manufacturer and category vocabulary the catalog UI builds its controls
 * from, plus each shop's sync health.
 *
 * Rows are projected onto `api/contracts.ts` explicitly — the browser's `<select>` contents must
 * not change shape because a table gained a column.
 */

import { canonicalCategoryDefinitions, getCategory } from "../catalog/categories.js";
import { SHOP_DEFINITIONS, getShopEnabled, getShopIntervalMinutes } from "../config.js";
import { buildSyncHealth } from "../health.js";
import type {
  MetaCategoryFacet,
  MetaResponse,
  MetaShop,
  MetaShopSyncState,
} from "../api/contracts.js";
import type { CategoryDefinition } from "../catalog/types.js";
import type { ShopSyncStateRow } from "../db/types.js";

interface MetaFacetRow {
  manufacturer_id?: string;
  value: string;
  active_product_count?: number | null;
}

/** Groups sort by their parent's order, then parents before children, then by own order. */
function categorySortKey(category: Pick<CategoryDefinition, "parentId" | "order">): number[] {
  const parent = category.parentId ? getCategory(category.parentId) : category;
  return [parent?.order || 999, category.parentId ? 1 : 0, category.order || 999];
}

/** Explicit row -> contract projection: `shop_sync_state` must not define the payload by itself. */
function toMetaShopSyncState(row: ShopSyncStateRow): MetaShopSyncState {
  return {
    shop_key: row.shop_key,
    last_attempt_at: row.last_attempt_at,
    last_success_at: row.last_success_at,
    last_error_at: row.last_error_at,
    consecutive_failures: row.consecutive_failures,
    backoff_until: row.backoff_until,
    last_error: row.last_error,
    last_item_count: row.last_item_count,
    queued_at: row.queued_at,
  };
}

export async function meta(env: Env): Promise<MetaResponse> {
  const states = await env.DB.prepare("SELECT * FROM shop_sync_state").all<ShopSyncStateRow>();
  const stateRows = states.results || [];
  const byKey = new Map(stateRows.map((row) => [row.shop_key, toMetaShopSyncState(row)]));
  const health = buildSyncHealth(env, stateRows);
  const healthByKey = new Map(health.shops.map((shop) => [shop.shopKey, shop]));
  // Driven by the registry, not by what happens to be in `shop_sync_state`: a shop that has never
  // run must still appear, with null sync state.
  const shops = Object.values(SHOP_DEFINITIONS).map((shop): MetaShop => ({
    key: shop.key,
    name: shop.name,
    enabled: getShopEnabled(env, shop),
    intervalMinutes: getShopIntervalMinutes(env, shop),
    sync: byKey.get(shop.key) || null,
    health: healthByKey.get(shop.key) || null,
  }));
  const facets = await env.DB.batch<MetaFacetRow>([
    env.DB.prepare(`
      SELECT manufacturer_id, MIN(manufacturer) AS value
      FROM products
      WHERE is_active = 1 AND manufacturer <> ''
      GROUP BY manufacturer_id
      ORDER BY value
    `),
    env.DB.prepare(`
      SELECT pc.category_id AS value, COUNT(DISTINCT pc.product_id) AS active_product_count
      FROM product_categories pc
      JOIN products p ON p.id = pc.product_id
      WHERE p.is_active = 1
      GROUP BY pc.category_id
    `),
  ]);
  const manufacturers = (facets[0]?.results || []).map((row) => row.value);
  const counts = new Map(
    (facets[1]?.results || []).map((row): [string, number] => [
      row.value,
      Number(row.active_product_count || 0),
    ]),
  );
  const categoryFacets = canonicalCategoryDefinitions()
    .filter((category) => category.filterable)
    .sort((left, right) => {
      const a = categorySortKey(left);
      const b = categorySortKey(right);
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    })
    .map((category): MetaCategoryFacet => {
      return {
        id: category.id,
        parentId: category.parentId,
        order: category.order,
        classifiable: category.classifiable,
        filterable: category.filterable,
        // Child categories are indented so a flat `<select>` still reads as a hierarchy.
        name: category.parentId ? `　${category.name}` : category.name,
        group: null,
        activeProductCount: counts.get(category.id) || 0,
      };
    });
  const categories = canonicalCategoryDefinitions()
    .filter((category) => category.classifiable)
    .map((category) => category.name);
  return { status: health.status, shops, manufacturers, categories, categoryFacets };
}
