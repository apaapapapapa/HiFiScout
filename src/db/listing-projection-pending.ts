import type { QueryableDatabase, ReadableDatabase } from "./types.js";

export interface PendingListingProjection {
  id: number;
  shop_key: string;
  source_id: string;
  token: string;
}

export async function readListingProjectionTokens(
  db: ReadableDatabase,
  shopKey: string,
  sourceIds: readonly string[],
): Promise<PendingListingProjection[]> {
  const rows: PendingListingProjection[] = [];
  for (let i = 0; i < sourceIds.length; i += 40) {
    const chunk = sourceIds.slice(i, i + 40);
    const result = await db
      .prepare(`
      SELECT p.id, p.shop_key, p.source_id, pending.token FROM products p
      JOIN listing_projection_pending pending ON pending.listing_product_id = p.id
      WHERE p.shop_key = ? AND p.source_id IN (${chunk.map(() => "?").join(",")})
    `)
      .bind(shopKey, ...chunk)
      .all<PendingListingProjection>();
    rows.push(...(result.results || []));
  }
  return rows;
}

/** An older refresh must not acknowledge work created while it was running. */
export async function acknowledgeListingProjections(
  db: QueryableDatabase,
  rows: readonly Pick<PendingListingProjection, "id" | "token">[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 40) {
    await db.batch(
      rows
        .slice(i, i + 40)
        .map((row) =>
          db
            .prepare(
              "DELETE FROM listing_projection_pending WHERE listing_product_id = ? AND token = ?",
            )
            .bind(row.id, row.token),
        ),
    );
  }
}

export async function acknowledgeCrawlListingProjections(
  db: QueryableDatabase,
  crawlRunId: number,
  sourceIds: readonly string[],
): Promise<void> {
  for (let i = 0; i < sourceIds.length; i += 40) {
    const chunk = sourceIds.slice(i, i + 40);
    const result = await db
      .prepare(`
      SELECT p.id, work.projection_token AS token FROM crawl_run_work_items work
      JOIN crawl_runs run ON run.id = work.crawl_run_id
      JOIN products p ON p.shop_key = run.shop_key AND p.source_id = work.source_id
      WHERE work.crawl_run_id = ? AND work.source_id IN (${chunk.map(() => "?").join(",")})
    `)
      .bind(crawlRunId, ...chunk)
      .all<{ id: number; token: string }>();
    await acknowledgeListingProjections(db, result.results || []);
  }
}
