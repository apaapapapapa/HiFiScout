import { InvocationBudgetExceeded } from "./invocation-budget.js";
import { refreshListingProjections } from "./listing-projection-refresh.js";
import { syncProductSearchEntities } from "./product-search-entity-repository.js";
import { exactIdentitySplitMembershipPredicateSql } from "./product-search-exact-identity.js";
import { firstMeasured } from "./read-accounting.js";
import type { QueryableDatabase } from "./types.js";
import { errorMessage } from "../types.js";

interface ProjectionGapRow {
  id: number;
  shop_key: string;
  source_id: string;
}

type ProjectionGapRepair = (
  db: QueryableDatabase,
  gaps: readonly ProjectionGapRow[],
  evaluatedAt: string,
) => Promise<void>;

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
   * Which phases this pass runs.
   *
   * The exact-identity phase is the one whose selector joins `products` to itself on identity, so
   * its cost per candidate listing is far above the other two, and it is also the lowest-priority
   * drift. Splitting it onto its own cadence needs both halves to be selectable: the phases share
   * one work budget, so a `coverage` pass that fills the budget would otherwise starve the phase
   * the hourly pass exists to run.
   *
   * - `all` runs every phase in priority order, which is what strict and daily callers want.
   * - `coverage` is critical coverage and stale fallback, the five-minute sweep.
   * - `exact-identity` is the peer scan alone, with the whole budget to itself.
   */
  phases?: "all" | "coverage" | "exact-identity";
  /**
   * Also report how many gaps are left after this pass.
   *
   * Off by default because the count is the one unbounded statement in this file: it scans every
   * active listing through correlated subqueries, and its cost grows with the catalog while the
   * repair itself stays bounded to `maxListings`. Callers that only need to know whether they
   * repaired anything already have {@link ProductSearchGapRepairResult.repairedCount}.
   *
   * Ask for it only where the number is read. That is `scripts/repair-product-search-gaps.ts`,
   * which exits non-zero on a remaining gap, and is the operator's authoritative on-demand count.
   * The scheduled callers do not: continuous per-invariant drift is what
   * `GET /api/admin/product-search/consistency` reports, and the deploy pipeline fails on it.
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
 * Missing Identity or offer membership is the highest-priority projection gap. These two indexed
 * existence checks are deliberately kept separate from the more expensive drift predicates below.
 *
 * Putting every gap kind in one OR made SQLite evaluate exact-identity peer/category correlated
 * subqueries while merely trying to find a handful of missing rows. On the production catalog that
 * selector can consume the D1 isolate CPU budget before refreshListingProjections is ever reached,
 * leaving the same critical coverage gaps behind on every five-minute repair tick.
 */
const CRITICAL_COVERAGE_GAP_PREDICATE = `
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
`;

/**
 * A fallback entity is stale once its representative has a verified Catalog match.
 *
 * Keep this as its own bounded phase. Combining it with exact-identity split detection under one OR
 * reintroduced the same D1 CPU hazard as the original all-in-one selector: SQLite could evaluate
 * the correlated peer/category scan across the active catalog before returning the single stale
 * fallback listing that production health was waiting for.
 */
const STALE_FALLBACK_GAP_PREDICATE = `
  EXISTS (
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
`;

/** Lowest-priority drift: this is the only bounded phase that performs exact-identity peer scans. */
const EXACT_IDENTITY_MEMBERSHIP_GAP_PREDICATE = exactIdentitySplitMembershipPredicateSql("p");

/**
 * Full authoritative predicate, used by the on-demand operator count and by strict verification.
 *
 * No scheduled caller evaluates it: it is the union of all three families, so it carries the
 * exact-identity self-join that dominates the cost.
 */
const ACTIVE_PROJECTION_GAP_PREDICATE = `
  (${CRITICAL_COVERAGE_GAP_PREDICATE})
  OR (${STALE_FALLBACK_GAP_PREDICATE})
  OR (${EXACT_IDENTITY_MEMBERSHIP_GAP_PREDICATE})
`;

async function selectProjectionGapsByPredicate(
  db: QueryableDatabase,
  afterId: number,
  limit: number,
  predicate: string,
): Promise<ProjectionGapRow[]> {
  const result = await db
    .prepare(`
      SELECT p.id, p.shop_key, p.source_id
      FROM products p
      WHERE p.is_active = 1
        AND p.id > ?
        AND (${predicate})
      ORDER BY p.id
      LIMIT ?
    `)
    .bind(afterId, limit)
    .all<ProjectionGapRow>();
  return result.results || [];
}

async function countActiveProjectionGaps(db: QueryableDatabase): Promise<number> {
  // Measured, not `first()`: this is the single most expensive statement in the file -- an aggregate
  // over every active listing through correlated subqueries -- and `first()` carries no `meta`, so
  // as a plain `first()` it was the biggest reader contributing nothing to the D1 usage totals.
  const row = await firstMeasured<{ gap_count: number }>(
    db.prepare(`
      SELECT COUNT(*) AS gap_count
      FROM products p
      WHERE p.is_active = 1
        AND (${ACTIVE_PROJECTION_GAP_PREDICATE})
    `),
  );
  return Number(row?.gap_count || 0);
}

async function countSeedGapsForPredicate(
  db: QueryableDatabase,
  listingIds: readonly number[],
  predicate: string,
): Promise<number> {
  const placeholders = listingIds.map(() => "?").join(",");
  // Bounded by id, but the exact-identity predicate still runs correlated peer scans per listing, so
  // this is measured for the same reason as the unbounded count above.
  const row = await firstMeasured<{ gap_count: number }>(
    db
      .prepare(`
        SELECT COUNT(*) AS gap_count
        FROM products p
        WHERE p.id IN (${placeholders})
          AND p.is_active = 1
          AND (${predicate})
      `)
      .bind(...listingIds),
  );
  return Number(row?.gap_count || 0);
}

async function countSeedGaps(
  db: QueryableDatabase,
  listingIds: readonly number[],
): Promise<number> {
  if (!listingIds.length) return 0;

  // Verify in the same priority order as selection. Do not pay for exact-identity peer scans when a
  // selected listing still has a cheaper coverage or stale-fallback invariant outstanding.
  const critical = await countSeedGapsForPredicate(db, listingIds, CRITICAL_COVERAGE_GAP_PREDICATE);
  if (critical > 0) return critical;

  const staleFallback = await countSeedGapsForPredicate(
    db,
    listingIds,
    STALE_FALLBACK_GAP_PREDICATE,
  );
  if (staleFallback > 0) return staleFallback;

  return countSeedGapsForPredicate(db, listingIds, EXACT_IDENTITY_MEMBERSHIP_GAP_PREDICATE);
}

const refreshFullProjectionPath: ProjectionGapRepair = async (db, gaps, evaluatedAt) => {
  await refreshListingProjections(db, gaps, evaluatedAt);
};

/**
 * A stale fallback is already past the critical-coverage gate: its listing has Identity and offer
 * rows, but the offer still points at an unresolved entity whose representative has since become a
 * verified Catalog match. Re-running projection + Identity work before fixing that membership is
 * unnecessary and, in production, could consume the D1 CPU budget before entity sync was reached.
 *
 * Entity sync is already transactional and expands exact-identity peers itself. Group seeds by shop
 * only because its incremental API is shop/source scoped, and execute the groups sequentially so a
 * repair batch never turns into another D1 burst.
 */
const refreshStaleFallbackMembershipOnly: ProjectionGapRepair = async (db, gaps) => {
  const sourceIdsByShop = new Map<string, string[]>();
  for (const gap of gaps) {
    const sourceIds = sourceIdsByShop.get(gap.shop_key) || [];
    sourceIds.push(gap.source_id);
    sourceIdsByShop.set(gap.shop_key, sourceIds);
  }
  for (const [shopKey, sourceIds] of sourceIdsByShop) {
    await syncProductSearchEntities(db, shopKey, sourceIds);
  }
};

async function repairAndVerify(
  db: QueryableDatabase,
  gaps: readonly ProjectionGapRow[],
  evaluatedAt: string,
  repair: ProjectionGapRepair,
): Promise<void> {
  await repair(db, gaps, evaluatedAt);
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
  repair: ProjectionGapRepair,
): Promise<{ repairedCount: number; failedCount: number }> {
  try {
    await repairAndVerify(db, gaps, evaluatedAt, repair);
    return { repairedCount: gaps.length, failedCount: 0 };
  } catch (error) {
    if (error instanceof InvocationBudgetExceeded) throw error;
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
      await repairAndVerify(db, [gap], evaluatedAt, repair);
      repairedCount += 1;
    } catch (error) {
      if (error instanceof InvocationBudgetExceeded) throw error;
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
 * Critical coverage reruns the same dependency-ordered projection path used by catalog/listing
 * remediation. Stale fallback membership uses the narrower transactional entity sync because the
 * prerequisite Identity/offer rows already exist. The five-minute bounded sweep isolates a failing
 * listing so it cannot starve later gaps; strict callers remain fail-fast unless explicitly opted
 * into the resilient mode.
 */
export async function repairActiveListingProjectionGaps(
  db: QueryableDatabase,
  {
    evaluatedAt = new Date().toISOString(),
    batchSize: requestedBatchSize,
    maxListings: requestedMaxListings,
    countRemainingGaps = false,
    continueOnRefreshError = !countRemainingGaps,
    phases = "all",
  }: ProductSearchGapRepairOptions = {},
): Promise<ProductSearchGapRepairResult> {
  const batchSize = positiveBoundedInteger(requestedBatchSize, DEFAULT_BATCH_SIZE, 50);
  const maxListings = positiveBoundedInteger(requestedMaxListings, DEFAULT_MAX_LISTINGS, 500);

  let selectedCount = 0;
  let repairedCount = 0;
  let failedCount = 0;
  const attemptedListingIds = new Set<number>();

  const repairPhase = async (
    predicate: string,
    repair: ProjectionGapRepair = refreshFullProjectionPath,
  ): Promise<void> => {
    // Each priority class owns its cursor. Reusing a higher-priority cursor can indefinitely starve
    // a lower-id gap whenever fresh higher-id work arrives between cron ticks.
    let afterId = 0;

    while (selectedCount < maxListings) {
      const limit = Math.min(batchSize, maxListings - selectedCount);
      const gaps = await selectProjectionGapsByPredicate(db, afterId, limit, predicate);
      if (!gaps.length) break;

      // Always advance using the raw selector batch. A row attempted in an earlier phase can still
      // satisfy this predicate after a failed refresh; skipping it must not trap the phase cursor.
      afterId = Number(gaps[gaps.length - 1]?.id || afterId);
      const unattemptedGaps = gaps.filter((gap) => !attemptedListingIds.has(Number(gap.id)));
      if (!unattemptedGaps.length) continue;

      // The sweep budget is per unique listing, not per predicate match. Carry attempted ids across
      // phases so one poison listing cannot consume multiple slots or inflate failedCount.
      for (const gap of unattemptedGaps) attemptedListingIds.add(Number(gap.id));
      selectedCount += unattemptedGaps.length;

      const refreshed = await refreshSelectedGaps(
        db,
        unattemptedGaps,
        evaluatedAt,
        continueOnRefreshError,
        repair,
      );
      repairedCount += refreshed.repairedCount;
      failedCount += refreshed.failedCount;
    }
  };

  // Keep the cheap, user-visible invariants ahead of the correlated peer scan. All phases start at
  // id 0 and share the overall work budget plus the attempted-id set: cursor position cannot starve
  // a lower-id phase, while overlapping predicates cannot spend the budget twice on one listing.
  if (phases !== "exact-identity") {
    await repairPhase(CRITICAL_COVERAGE_GAP_PREDICATE);
    if (selectedCount < maxListings) {
      await repairPhase(STALE_FALLBACK_GAP_PREDICATE, refreshStaleFallbackMembershipOnly);
    }
  }
  if (phases !== "coverage" && selectedCount < maxListings) {
    await repairPhase(EXACT_IDENTITY_MEMBERSHIP_GAP_PREDICATE);
  }

  const result: ProductSearchGapRepairResult = {
    selectedCount,
    repairedCount,
    remainingGapCount: countRemainingGaps ? await countActiveProjectionGaps(db) : null,
  };
  if (failedCount > 0) result.failedCount = failedCount;
  return result;
}
