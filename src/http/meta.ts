/**
 * `/api/meta`: the shop, manufacturer and category vocabulary the catalog UI builds its controls
 * from, plus each shop's sync health.
 *
 * Rows are projected onto `api/contracts.ts` explicitly — the browser's `<select>` contents must
 * not change shape because a table gained a column.
 */

import { canonicalCategoryDefinitions, getCategory } from "../catalog/categories.js";
import { normalizeManufacturer } from "../catalog/manufacturers.js";
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

/** Full root-to-leaf path. Cycles are cut defensively even though the authored taxonomy forbids them. */
function categoryHierarchy(category: CategoryDefinition): CategoryDefinition[] {
  const path: CategoryDefinition[] = [];
  const seen = new Set<string>();
  let current: CategoryDefinition | null = category;
  while (current && !seen.has(current.id)) {
    path.unshift(current);
    seen.add(current.id);
    current = current.parentId ? getCategory(current.parentId) : null;
  }
  return path;
}

/** Parents precede descendants; siblings follow their authored `order` at every hierarchy depth. */
export function compareCategoryHierarchy(
  left: CategoryDefinition,
  right: CategoryDefinition,
): number {
  const a = categoryHierarchy(left);
  const b = categoryHierarchy(right);
  const sharedDepth = Math.min(a.length, b.length);
  for (let index = 0; index < sharedDepth; index += 1) {
    const orderDifference = (a[index]?.order || 999) - (b[index]?.order || 999);
    if (orderDifference) return orderDifference;
  }
  return a.length - b.length || left.id.localeCompare(right.id);
}

export function categoryHierarchyDepth(category: CategoryDefinition): number {
  return Math.max(0, categoryHierarchy(category).length - 1);
}

/**
 * Public manufacturer vocabulary must not expose stale seller presentation text while a resolver
 * version replay is still draining. Canonicalization is also a dedupe boundary: `LUXMAN`,
 * `〖中古品〗LUXMAN` and `【展示処分品】LUXMAN` are one filter option, not three.
 */
export function normalizeManufacturerFacetValues(
  rows: readonly Pick<MetaFacetRow, "value">[],
): string[] {
  const values = rows
    .map((row) => normalizeManufacturer(row.value).displayName)
    .filter((value): value is string => Boolean(value));
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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
  const manufacturers = normalizeManufacturerFacetValues(facets[0]?.results || []);
  const counts = new Map(
    (facets[1]?.results || []).map((row): [string, number] => [
      row.value,
      Number(row.active_product_count || 0),
    ]),
  );
  const categoryFacets = canonicalCategoryDefinitions()
    .filter((category) => category.filterable)
    .sort(compareCategoryHierarchy)
    .map((category): MetaCategoryFacet => {
      const depth = categoryHierarchyDepth(category);
      return {
        id: category.id,
        parentId: category.parentId,
        order: category.order,
        classifiable: category.classifiable,
        filterable: category.filterable,
        // Preserve hierarchy depth even though the browser renders a flat `<select>`.
        name: `${"　".repeat(depth)}${category.name}`,
        group: null,
        activeProductCount: counts.get(category.id) || 0,
      };
    });
  const categories = canonicalCategoryDefinitions()
    .filter((category) => category.classifiable)
    .map((category) => category.name);
  return { status: health.status, shops, manufacturers, categories, categoryFacets };
}
