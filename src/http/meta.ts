/**
 * `/api/meta`: the shop, manufacturer and category vocabulary the catalog UI builds its controls
 * from, plus each shop's sync health.
 *
 * Rows are projected onto `api/contracts.ts` explicitly — the browser's `<select>` contents must
 * not change shape because a table gained a column.
 */

import {
  LEGACY_CATEGORY_MIGRATION_RULES,
  TAXONOMY_VERSION,
  canonicalCategoryDefinitions,
  getCategory,
} from "../catalog/categories.js";
import { normalizeManufacturer } from "../catalog/manufacturers.js";
import { SHOP_DEFINITIONS, getShopEnabled, getShopIntervalMinutes } from "../config.js";
import { buildSyncHealth } from "../health.js";
import type {
  MetaCategoryFacet,
  MetaManufacturerFacet,
  MetaProductFacet,
  MetaResponse,
  MetaShop,
  MetaShopSyncState,
} from "../api/contracts.js";
import { FACET_DEFINITIONS } from "../catalog/types.js";
import type { CategoryDefinition } from "../catalog/types.js";
import { readPublicMetaSnapshot } from "../db/public-meta-repository.js";
import type { MetaBatchRow } from "../db/public-meta-repository.js";
import type { ShopSyncStateRow } from "../db/types.js";

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
  rows: readonly Pick<MetaBatchRow, "value">[],
): string[] {
  const values = rows
    .map((row) => normalizeManufacturer(row.value || "").displayName)
    .filter((value): value is string => Boolean(value));
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/** Canonicalize manufacturer labels and merge counts for aliases that collapse to one public name. */
export function normalizeManufacturerFacets(
  rows: readonly Pick<MetaBatchRow, "value" | "active_product_count">[],
): MetaManufacturerFacet[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const name = normalizeManufacturer(row.value || "").displayName;
    if (!name) continue;
    const count = Number(row.active_product_count || 0);
    counts.set(name, (counts.get(name) || 0) + (Number.isFinite(count) ? count : 0));
  }
  return [...counts.entries()]
    .map(([name, activeProductCount]) => ({ name, activeProductCount }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Explicit row -> contract projection: `shop_sync_state` must not define the payload by itself. */
function toMetaShopSyncState(row: ShopSyncStateRow): MetaShopSyncState {
  return {
    shop_key: row.shop_key,
    last_attempt_at: row.last_attempt_at,
    last_success_at: row.last_success_at,
    last_projection_at: row.last_projection_at,
    last_error_at: row.last_error_at,
    consecutive_failures: row.consecutive_failures,
    backoff_until: row.backoff_until,
    // Raw crawler errors can contain upstream URLs or diagnostics; public metadata keeps only the
    // timestamp/failure counters and structured health reason.
    last_error: null,
    last_item_count: row.last_item_count,
    // Crawl Queue retirement removed the SQL column, not this nullable public compatibility field.
    // Undefined disappears during JSON serialization and makes every populated shop fail validation.
    queued_at: row.queued_at ?? null,
  };
}

export async function meta(env: Env): Promise<MetaResponse> {
  const states = await env.DB.prepare("SELECT * FROM shop_sync_state").all<ShopSyncStateRow>();
  const stateRows = states.results || [];
  const byKey = new Map(stateRows.map((row) => [row.shop_key, toMetaShopSyncState(row)]));
  const health = buildSyncHealth(env, stateRows);
  const healthByKey = new Map(health.shops.map((shop) => [shop.shopKey, shop]));
  const snapshot = await readPublicMetaSnapshot(env.DB);
  const batches = snapshot.batches;

  const vocabularyRows = batches[0]?.results || [];
  const manufacturerFacets = normalizeManufacturerFacets(
    vocabularyRows.filter((row) => row.facet_kind === "manufacturer"),
  );
  const manufacturers = manufacturerFacets.map((facet) => facet.name);
  const shopCounts = new Map(
    vocabularyRows
      .filter((row) => row.facet_kind === "shop")
      .map((row) => [row.value || "", Number(row.active_product_count || 0)] as const),
  );

  // Driven by the registry, not by what happens to be in `shop_sync_state`: a shop that has never
  // run must still appear, with null sync state and a zero count when it has no active listings.
  const shops = Object.values(SHOP_DEFINITIONS).map((shop): MetaShop => ({
    key: shop.key,
    name: shop.name,
    enabled: getShopEnabled(env, shop),
    intervalMinutes: getShopIntervalMinutes(env, shop),
    activeProductCount: shopCounts.get(shop.key) || 0,
    sync: byKey.get(shop.key) || null,
    health: healthByKey.get(shop.key) || null,
  }));

  const counts = new Map<string, number>();
  for (const row of batches[1]?.results || []) {
    const categoryId = getCategory(row.value || "")?.id || row.value || "";
    counts.set(categoryId, (counts.get(categoryId) || 0) + Number(row.active_product_count || 0));
  }
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
  const facetCounts = new Map(
    (batches[2]?.results || []).map((row) => [
      `${row.facet_id || ""}:${row.facet_value || ""}`,
      Number(row.active_product_count || 0),
    ]),
  );
  const productFacets: MetaProductFacet[] = FACET_DEFINITIONS.flatMap((definition) =>
    definition.values.map((value) => ({
      facetId: definition.id,
      value: value.id,
      name: value.name,
      group: definition.name,
      order: definition.order * 100 + value.order,
      activeProductCount: facetCounts.get(`${definition.id}:${value.id}`) || 0,
    })),
  );
  const taxonomyRow = batches[3]?.results?.[0] || {};
  return {
    status: health.status,
    countsUpdatedAt: snapshot.generatedAt,
    shops,
    manufacturers,
    manufacturerFacets,
    categories,
    categoryFacets,
    taxonomyVersion: TAXONOMY_VERSION,
    facets: productFacets,
    legacyCategoryAliases: Object.fromEntries(
      LEGACY_CATEGORY_MIGRATION_RULES.map((rule) => [rule.legacyId, rule.categoryIds]),
    ),
    taxonomyHealth: {
      activeProductCount: Number(taxonomyRow.active_count || 0),
      unclassifiedProductCount: Number(taxonomyRow.unclassified_count || 0),
      lowConfidenceProductCount: Number(taxonomyRow.low_confidence_count || 0),
      legacyCategoryResidueCount: Number(taxonomyRow.legacy_residue_count || 0),
      legacyOtherResidualCount: Number(taxonomyRow.legacy_other_count || 0),
      migratedCategoryShiftCount: Number(taxonomyRow.migrated_shift_count || 0),
    },
  };
}
