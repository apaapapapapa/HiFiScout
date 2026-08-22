import { refreshListingProjections } from "./listing-projection-refresh.js";
import type { QueryableDatabase } from "./types.js";

interface ProjectionGapRow {
  id: number;
  shop_key: string;
  source_id: string;
}

export interface ProductSearchGapRepairOptions {
  evaluatedAt?: string;
  batchSize?: number;
  maxListings?: number;
}

export interface ProductSearchGapRepairResult {
  selectedCount: number;
  repairedCount: number;
  remainingGapCount: number;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_LISTINGS = 100;

function positiveBoundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`Expected an integer in [1, ${max}], got ${value}`);
  }
  return value;
}

async function selectActiveProjectionGaps(
  db: QueryableDatabase,
  afterId: number,
  limit: number,
): Promise<ProjectionGapRow[]> {
  const result = await db
    .prepare(`
      SELECT p.id, p.shop_key, p.source_id
      FROM products p
      WHERE p.is_active = 1
        AND p.id > ?
        AND (
          NOT EXISTS (
            SELECT 1
            FROM product_identity_resolutions r
            WHERE r.listing_product_id = p.id
          )
          OR NOT EXISTS (
            SELECT 1
            FROM product_search_entity_offers o
            WHERE o.listing_product_id = p.id
          )
        )
      ORDER BY p.id
      LIMIT ?
    `)
    .bind(afterId, limit)
    .all<ProjectionGapRow>();
  return result.results || [];
}

async function countActiveProjectionGaps(db: QueryableDatabase): Promise<number> {
  const row = await db
    .prepare(`
      SELECT COUNT(*) AS gap_count
      FROM products p
      WHERE p.is_active = 1
        AND (
          NOT EXISTS (
            SELECT 1
            FROM product_identity_resolutions r
            WHERE r.listing_product_id = p.id
          )
          OR NOT EXISTS (
            SELECT 1
            FROM product_search_entity_offers o
            WHERE o.listing_product_id = p.id
          )
        )
    `)
    .first<{ gap_count: number }>();
  return Number(row?.gap_count || 0);
}

async function countSeedGaps(
  db: QueryableDatabase,
  listingIds: readonly number[],
): Promise<number> {
  if (!listingIds.length) return 0;
  const placeholders = listingIds.map(() => "?").join(",");
  const row = await db
    .prepare(`
      SELECT COUNT(*) AS gap_count
      FROM products p
      WHERE p.id IN (${placeholders})
        AND p.is_active = 1
        AND (
          NOT EXISTS (
            SELECT 1
            FROM product_identity_resolutions r
            WHERE r.listing_product_id = p.id
          )
          OR NOT EXISTS (
            SELECT 1
            FROM product_search_entity_offers o
            WHERE o.listing_product_id = p.id
          )
        )
    `)
    .bind(...listingIds)
    .first<{ gap_count: number }>();
  return Number(row?.gap_count || 0);
}

/**
 * Repairs bounded active-listing gaps left by an interrupted write between the listing table and
 * the derived Identity/Product Search read model.
 *
 * The repair never fabricates placeholder rows. It reruns the same dependency-ordered projection
 * path used by catalog/listing remediation: search projection -> Product Identity -> search entity.
 * A batch that does not converge is treated as an error so callers cannot silently skip a corrupt
 * listing by advancing the cursor beyond it.
 */
export async function repairActiveListingProjectionGaps(
  db: QueryableDatabase,
  {
    evaluatedAt = new Date().toISOString(),
    batchSize: requestedBatchSize,
    maxListings: requestedMaxListings,
  }: ProductSearchGapRepairOptions = {},
): Promise<ProductSearchGapRepairResult> {
  const batchSize = positiveBoundedInteger(requestedBatchSize, DEFAULT_BATCH_SIZE, 50);
  const maxListings = positiveBoundedInteger(requestedMaxListings, DEFAULT_MAX_LISTINGS, 500);

  let selectedCount = 0;
  let repairedCount = 0;
  let afterId = 0;

  while (selectedCount < maxListings) {
    const limit = Math.min(batchSize, maxListings - selectedCount);
    const gaps = await selectActiveProjectionGaps(db, afterId, limit);
    if (!gaps.length) break;

    selectedCount += gaps.length;
    afterId = Number(gaps[gaps.length - 1]?.id || afterId);
    await refreshListingProjections(db, gaps, evaluatedAt);

    const remainingInBatch = await countSeedGaps(
      db,
      gaps.map((gap) => Number(gap.id)),
    );
    if (remainingInBatch > 0) {
      throw new Error(
        `Product Search projection repair did not converge for ${remainingInBatch}/${gaps.length} selected active listings`,
      );
    }
    repairedCount += gaps.length;
  }

  return {
    selectedCount,
    repairedCount,
    remainingGapCount: await countActiveProjectionGaps(db),
  };
}
