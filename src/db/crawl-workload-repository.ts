import type { QueryableDatabase, ReadableDatabase } from "./types.js";

/**
 * What a shop's crawls have actually cost, as high-water marks.
 *
 * A scheduling hint and nothing more: no stage, chunk, checkpoint or budget decision reads it, so a
 * shop with no observations at all is still bounded by the same runner.
 */
export interface CrawlWorkloadObservation {
  shopKey: string;
  /** The largest inventory this shop has ever reported. */
  peakItemCount: number;
  /** How often a crawl had to hand derived work to the continuation sweep. */
  budgetExhaustedCount: number;
  lastBudgetExhaustedAt: string | null;
}

interface CrawlWorkloadObservationRow {
  shop_key: string;
  peak_item_count: number;
  budget_exhausted_count: number;
  last_budget_exhausted_at: string | null;
}

function toObservation(row: CrawlWorkloadObservationRow): CrawlWorkloadObservation {
  return {
    shopKey: row.shop_key,
    peakItemCount: Number(row.peak_item_count || 0),
    budgetExhaustedCount: Number(row.budget_exhausted_count || 0),
    lastBudgetExhaustedAt: row.last_budget_exhausted_at || null,
  };
}

/**
 * Folds one completed crawl into the shop's high-water marks.
 *
 * Nothing here decays. A shop that was large once is treated as large from then on, because the
 * cost of scheduling a small shop in the heavy lane is a slower turn, while the cost of the reverse
 * is the invocation that never completes.
 */
export async function recordCrawlWorkloadObservation(
  db: QueryableDatabase,
  shopKey: string,
  {
    itemCount,
    budgetExhausted,
    observedAt,
  }: { itemCount: number; budgetExhausted: boolean; observedAt: string },
): Promise<void> {
  const exhausted = budgetExhausted ? 1 : 0;
  await db
    .prepare(`
      INSERT INTO crawl_workload_observations (
        shop_key, peak_item_count, budget_exhausted_count, last_budget_exhausted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(shop_key) DO UPDATE SET
        peak_item_count = MAX(peak_item_count, excluded.peak_item_count),
        budget_exhausted_count = budget_exhausted_count + ?,
        last_budget_exhausted_at = CASE
          WHEN ? THEN excluded.last_budget_exhausted_at ELSE last_budget_exhausted_at END,
        updated_at = excluded.updated_at
    `)
    .bind(
      shopKey,
      Math.max(0, Math.trunc(itemCount)),
      exhausted,
      budgetExhausted ? observedAt : null,
      observedAt,
      exhausted,
      exhausted,
    )
    .run();
}

export async function getCrawlWorkloadObservation(
  db: ReadableDatabase,
  shopKey: string,
): Promise<CrawlWorkloadObservation | null> {
  const row = await db
    .prepare(`
      SELECT shop_key, peak_item_count, budget_exhausted_count, last_budget_exhausted_at
      FROM crawl_workload_observations WHERE shop_key = ?
    `)
    .bind(shopKey)
    .first<CrawlWorkloadObservationRow>();
  return row ? toObservation(row) : null;
}

/** Every shop's observations, keyed by shop, so one dispatch batch reads them once. */
export async function listCrawlWorkloadObservations(
  db: ReadableDatabase,
): Promise<Map<string, CrawlWorkloadObservation>> {
  const result = await db
    .prepare(`
      SELECT shop_key, peak_item_count, budget_exhausted_count, last_budget_exhausted_at
      FROM crawl_workload_observations
    `)
    .all<CrawlWorkloadObservationRow>();
  return new Map((result.results || []).map((row) => [row.shop_key, toObservation(row)] as const));
}
