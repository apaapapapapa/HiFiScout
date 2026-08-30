import { refreshListingProjections } from "./listing-projection-refresh.js";
import { exactIdentitySplitMembershipPredicateSql } from "./product-search-exact-identity.js";
import type { QueryableDatabase } from "./types.js";
import { errorMessage } from "../types.js";

interface ProjectionGapRow {
  id: number;
  shop_key: string;
  source_id: string;
}

export interface ProductSearchGapRepairOptions {
  evaluatedAt?: string;
  batchSize?: number;
  maxListings?: number;
  /**
   * Continue past a projection failure by retrying the selected batch one listing at a time.
   *
   * This is intended for the bounded five-minute maintenance sweep: a single poison listing must
   * not permanently starve every higher-id gap. The failed listing remains a gap and is retried on
   * the next sweep. Strict/authoritative callers should leave this disabled so any failed repair is
   * surfaced immediately.
   *
   * When omitted, bounded callers that do not request the unbounded remaining-gap count use the
   * resilient mode, while callers asking for the authoritative remaining count remain fail-fast.
   */
  continueOnRefreshError?: boolean;
  /**
   * Also report how many gaps are left after this pass.
   *
   * Off by default because the count is the one unbounded statement in this file: it scans every
   * active listing through correlated subqueries, and its cost grows with the catalog while the
   * repair itself stays bounded to `maxListings`. Callers that only need to know whether they
   * repaired anything already have {@link ProductSearchGapRepairResult.repairedCount}.
   */
  countRemainingGaps?: boolean;
}

export interface ProductSearchGapRepairResult {
  selectedCount: number;
  repairedCount: number;
  /** Selected listings that still failed after per-listing isolation. Present only when non-zero. */
  failedCount?: number;
  /** Gaps still outstanding, or `null` when the caller did not ask to pay for the count. */
  remainingGapCount: number | null;
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

/**
 * An active listing needs projection repair when any stage is missing, when it belongs to a
 * fallback entity whose representative listing has already become a verified Catalog match, or
 * when a safe exact manufacturer/model identity is split across multiple fallback entities.
 *
 * The representative clause deliberately follows the entity membership rather than only checking
 * the current listing's own Identity row. Exact-identity grouping allows several unresolved offers
 * to share `l-<representative id>`. If that representative is promoted between bounded writes, its
 * own offer may already move to Catalog while peers remain attached to the now-stale fallback. In
 * that state the peer is the row that must be replayed so the unresolved group can elect a current
 * representative and the obsolete entity can be pruned.
 *
 * The exact-identity split clause catches a different interrupted-write/drift state: all required
 * rows already exist, but memberships that are safe to group no longer point to one entity. A
 * single selected listing is sufficient because the search-entity sync expands it to every safe
 * exact peer before rewriting membership. Both clauses are listing-scoped counterparts of the
 * invariants reported by Product Search operational checks.
 */
const ACTIVE_PROJECTION_GAP_PREDICATE = `
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
  OR EXISTS (
    SELECT 1
    FROM product_search_entity_offers o
    JOIN product_search_entities e
      ON e.id = o.entity_id AND e.entity_kind = 'unresolved_listing'
    JOIN product_identity_resolutions representative_r
      ON representative_r.listing_product_id = e.fallback_listing_id
      AND representative_r.status = 'matched'
    JOIN knowledge_catalog_products representative_kp
      ON representative_kp.id = representative_r.catalog_product_id
      AND representative_kp.verification_status = 'verified'
    WHERE o.listing_product_id = p.id
  )
  OR (${exactIdentitySplitMembershipPredicateSql("p")})
`;

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
        AND (${ACTIVE_PROJECTION_GAP_PREDICATE})
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
        AND (${ACTIVE_PROJECTION_GAP_PREDICATE})
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
        AND (${ACTIVE_PROJECTION_GAP_PREDICATE})
    `)
    .bind(...listingIds)
    .first<{ gap_count: number }>();
  return Number(row?.gap_count || 0);
}

async function refreshAndVerify(
  db: QueryableDatabase,
  gaps: readonly ProjectionGapRow[],
  evaluatedAt: string,
): Promise<void> {
  await refreshListingProjections(db, gaps, evaluatedAt);
  const remaining = await countSeedGaps(
    db,
    gaps.map((gap) => Number(gap.id)),
  );
  if (remaining > 0) {
    throw new Error(
      `Product Search projection repair did not converge for ${remaining}/${gaps.length} selected active listings`,
    );
  }
}

async function refreshSelectedGaps(
  db: QueryableDatabase,
  gaps: readonly ProjectionGapRow[],
  evaluatedAt: string,
  continueOnRefreshError: boolean,
): Promise<{ repairedCount: number; failedCount: number }> {
  try {
    await refreshAndVerify(db, gaps, evaluatedAt);
    return { repairedCount: gaps.length, failedCount: 0 };
  } catch (error) {
    if (!continueOnRefreshError) throw error;
    console.warn(
      JSON.stringify({
        event: "product_search_projection_repair_batch_failed",
        listingIds: gaps.map((gap) => gap.id),
        message: errorMessage(error),
      }),
    );
  }

  let repairedCount = 0;
  let failedCount = 0;
  for (const gap of gaps) {
    try {
      await refreshAndVerify(db, [gap], evaluatedAt);
      repairedCount += 1;
    } catch (error) {
      failedCount += 1;
      console.warn(
        JSON.stringify({
          event: "product_search_projection_repair_listing_failed",
          listingId: gap.id,
          shopKey: gap.shop_key,
          sourceId: gap.source_id,
          message: errorMessage(error),
        }),
      );
    }
  }
  return { repairedCount, failedCount };
}

/**
 * Repairs bounded active-listing gaps left by an interrupted write between the listing table and
 * the derived Identity/Product Search read model.
 *
 * The repair never fabricates placeholder rows. It reruns the same dependency-ordered projection
 * path used by catalog/listing remediation: search projection -> Product Identity -> search entity.
 * The five-minute bounded sweep isolates a failing listing so it cannot starve later gaps; strict
 * callers still fail fast unless they explicitly opt into the resilient mode.
 */
export async function repairActiveListingProjectionGaps(
  db: QueryableDatabase,
  {
    evaluatedAt = new Date().toISOString(),
    batchSize: requestedBatchSize,
    maxListings: requestedMaxListings,
    countRemainingGaps = false,
    continueOnRefreshError = !countRemainingGaps,
  }: ProductSearchGapRepairOptions = {},
): Promise<ProductSearchGapRepairResult> {
  const batchSize = positiveBoundedInteger(requestedBatchSize, DEFAULT_BATCH_SIZE, 50);
  const maxListings = positiveBoundedInteger(requestedMaxListings, DEFAULT_MAX_LISTINGS, 500);

  let selectedCount = 0;
  let repairedCount = 0;
  let failedCount = 0;
  let afterId = 0;

  while (selectedCount < maxListings) {
    const limit = Math.min(batchSize, maxListings - selectedCount);
    const gaps = await selectActiveProjectionGaps(db, afterId, limit);
    if (!gaps.length) break;

    // Advance the bounded scan before repair. In resilient mode this is the key starvation guard:
    // a poison row remains a gap for the next cron, but it cannot trap every higher-id listing
    // behind the same failed first batch forever.
    selectedCount += gaps.length;
    afterId = Number(gaps[gaps.length - 1]?.id || afterId);

    const refreshed = await refreshSelectedGaps(db, gaps, evaluatedAt, continueOnRefreshError);
    repairedCount += refreshed.repairedCount;
    failedCount += refreshed.failedCount;
  }

  const result: ProductSearchGapRepairResult = {
    selectedCount,
    repairedCount,
    remainingGapCount: countRemainingGaps ? await countActiveProjectionGaps(db) : null,
  };
  if (failedCount > 0) result.failedCount = failedCount;
  return result;
}
