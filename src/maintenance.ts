import { getMaintenanceSettings } from "./config.js";
import type { CrawlerEnv, MaintenanceSettings } from "./crawler/types.js";
import { deleteTerminalCrawlFetchSessions } from "./db/crawl-fetch-session-repository.js";
import { cleanupProductCorrectionReports } from "./db/product-correction-report-repository.js";
import type { QueryableDatabase } from "./db/types.js";

/** `runRetentionCleanup` always writes, so the database binding is required here. */
export interface RetentionEnv extends CrawlerEnv {
  readonly DB: QueryableDatabase;
}

export interface RetentionCutoffs {
  settings: MaintenanceSettings;
  crawlRunsBefore: string;
  dataQualityBefore: string;
  remediationQueueBefore: string;
  priceHistoryBefore: string;
  inactiveProductsBefore: string;
}

export interface RetentionCleanupCounts {
  evidenceMetadata: number;
  productAuditExports: number;
  knowledgeCatalogExports: number;
  dataQualityRuns: number;
  remediationQueue: number;
  correctionReports: number;
  crawlFetchSessions: number;
  crawlRuns: number;
  priceHistory: number;
  inactiveProducts: number;
  emptySearchEntities: number;
}

export interface RetentionCleanupResult {
  event: "retention_cleanup";
  at: string;
  deleted: RetentionCleanupCounts;
}

function cutoffIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function retentionCutoffs(env: CrawlerEnv, now = new Date()): RetentionCutoffs {
  const settings = getMaintenanceSettings(env);
  return {
    settings,
    crawlRunsBefore: cutoffIso(now, settings.crawlRunRetentionDays),
    dataQualityBefore: cutoffIso(now, settings.dataQualityRetentionDays),
    remediationQueueBefore: cutoffIso(now, settings.remediationQueueRetentionDays),
    priceHistoryBefore: cutoffIso(now, settings.priceHistoryRetentionDays),
    inactiveProductsBefore: cutoffIso(now, settings.inactiveProductRetentionDays),
  };
}

function changes(result: D1Response): number {
  return Number(result?.meta?.changes || 0);
}

/** Bound scope fragments the same way the search-entity projection does. */
const CLEANUP_CHUNK_SIZE = 40;

function chunked<T>(values: readonly T[], size = CLEANUP_CHUNK_SIZE): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function sum(results: readonly D1Response[]): number {
  return results.reduce((total, result) => total + changes(result), 0);
}

/**
 * Ages out inactive listings, and retires the entities whose last offer they were.
 *
 * The read model's invariant is that every entity has an active offer, and deleting a listing
 * cascades its membership away, so a listing leaving can be the thing that empties an entity. What
 * that used to cost was a `NOT EXISTS` delete over the whole of `product_search_entities` on every
 * retention run -- a read proportional to the catalog, performed to find a set that is almost always
 * empty. Almost, because a listing is normally unlinked when it is deactivated, long before
 * retention deletes the row; the residue this has to catch is a listing whose deactivation
 * projection never completed.
 *
 * The sweep is now scoped to the entities those listings still belonged to, read before the cascade
 * removes the evidence. Bounding it this way is only safe because nothing else needs it: the
 * projection path already prunes to the entity IDs it touched, `rebuildProductSearchEntities` is an
 * explicit full repair rather than a cadence, and this is the only path in the codebase that deletes
 * a `products` row at all.
 *
 * Three properties this rests on, in the order they matter:
 *
 * - The candidate set is derived from the listing IDs actually passed to the delete, not from a
 *   second evaluation of the selector, so a concurrent write cannot shift the window and leave an
 *   orphan outside the set.
 * - The delete keeps the original predicate, so a listing reactivated between the read and the
 *   write is not deleted for having once matched. Its entity stays in the candidate set, which is
 *   harmless: the set may over-approximate, never under-approximate.
 * - `NOT EXISTS` is still evaluated at write time, so an entity that gained an offer after the
 *   candidate read -- including the listing being re-added -- survives.
 *
 * Both halves go in one batch, so an interruption cannot commit the cascade and lose the sweep that
 * answers for it.
 */
async function retireInactiveListings(
  db: QueryableDatabase,
  { before, limit }: { before: string; limit: number },
): Promise<{ listings: number; entities: number }> {
  const selected = await db
    .prepare(`
      SELECT id FROM products
      WHERE is_active = 0 AND last_seen_at < ?
      ORDER BY last_seen_at ASC
      LIMIT ?
    `)
    .bind(before, limit)
    .all<{ id: number }>();
  const listingIds = (selected.results || []).map((row) => Number(row.id));
  if (listingIds.length === 0) return { listings: 0, entities: 0 };

  const affected = new Set<number>();
  for (const chunk of chunked(listingIds)) {
    const memberships = await db
      .prepare(`
        SELECT DISTINCT entity_id FROM product_search_entity_offers
        WHERE listing_product_id IN (${placeholders(chunk.length)})
      `)
      .bind(...chunk)
      .all<{ entity_id: number }>();
    for (const row of memberships.results || []) affected.add(Number(row.entity_id));
  }

  const listingStatements = chunked(listingIds).map((chunk) =>
    db
      .prepare(`
        DELETE FROM products
        WHERE id IN (${placeholders(chunk.length)})
          AND is_active = 0
          AND last_seen_at < ?
      `)
      .bind(...chunk, before),
  );
  const entityStatements = chunked([...affected]).map((chunk) =>
    db
      .prepare(`
        DELETE FROM product_search_entities
        WHERE id IN (${placeholders(chunk.length)})
          AND NOT EXISTS (
            SELECT 1 FROM product_search_entity_offers m WHERE m.entity_id = product_search_entities.id
          )
      `)
      .bind(...chunk),
  );

  const results = await db.batch([...listingStatements, ...entityStatements]);
  return {
    listings: sum(results.slice(0, listingStatements.length)),
    entities: sum(results.slice(listingStatements.length)),
  };
}

/**
 * Ages resolved remediation jobs out, in bounded statements, until the horizon is clear. Failed
 * jobs are left alone, as before: they are the ones worth keeping for diagnosis.
 *
 * Every other table in this cleanup is a log that accrues at the rate the system does work, so one
 * capped statement a day keeps up. This queue accrues one row per active listing per resolver
 * version bump and never reuses a settled row, which is how it reached 78k rows without a single
 * delete becoming eligible. A single delete is not enough to drain that, and one enormous delete
 * is exactly the kind of write that has D1 reset itself — so this shards the work the way
 * Cloudflare's own guidance says to, and stops at `totalLimit` so a backlog is spread over runs
 * instead of spent in one.
 */
async function pruneRemediationQueue(
  db: QueryableDatabase,
  { before, batchSize, totalLimit }: { before: string; batchSize: number; totalLimit: number },
): Promise<number> {
  let deleted = 0;
  while (deleted < totalLimit) {
    const wanted = Math.min(batchSize, totalLimit - deleted);
    const batch = await db
      .prepare(`
        DELETE FROM data_quality_remediation_queue
        WHERE id IN (
          SELECT id FROM data_quality_remediation_queue
          WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < ?
          ORDER BY resolved_at ASC, id ASC
          LIMIT ?
        )
      `)
      .bind(before, wanted)
      .run();
    const removed = changes(batch);
    deleted += removed;
    // A batch that came back short means the horizon is exhausted. Stopping on that rather than on
    // an empty batch saves the one wasted round trip that would otherwise end every drained run.
    if (removed < wanted) break;
  }
  return deleted;
}

export async function runRetentionCleanup(
  env: RetentionEnv,
  { now = new Date() }: { now?: Date } = {},
): Promise<RetentionCleanupResult> {
  const {
    settings,
    crawlRunsBefore,
    dataQualityBefore,
    remediationQueueBefore,
    priceHistoryBefore,
    inactiveProductsBefore,
  } = retentionCutoffs(env, now);
  const limit = settings.deleteBatchSize;

  const evidenceMetadata = await env.DB.prepare(`
    DELETE FROM evidence_archive
    WHERE id IN (
      SELECT id FROM evidence_archive
      WHERE expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at ASC
      LIMIT ?
    )
  `)
    .bind(now.toISOString(), limit)
    .run();

  const knowledgeCatalogExports = await env.DB.prepare(`
    DELETE FROM knowledge_catalog_export_jobs
    WHERE id IN (
      SELECT id FROM knowledge_catalog_export_jobs
      WHERE expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at ASC, id ASC
      LIMIT ?
    )
  `)
    .bind(now.toISOString(), limit)
    .run();

  const productAuditExports = await env.DB.prepare(`
    DELETE FROM product_audit_export_jobs
    WHERE id IN (
      SELECT id FROM product_audit_export_jobs
      WHERE expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at ASC, id ASC
      LIMIT ?
    )
  `)
    .bind(now.toISOString(), limit)
    .run();

  const dataQualityRuns = await env.DB.prepare(`
    DELETE FROM data_quality_runs
    WHERE id IN (
      SELECT id FROM data_quality_runs
      WHERE evaluated_at < ?
      ORDER BY evaluated_at ASC, id ASC
      LIMIT ?
    )
  `)
    .bind(dataQualityBefore, limit)
    .run();

  const remediationQueue = await pruneRemediationQueue(env.DB, {
    before: remediationQueueBefore,
    batchSize: limit,
    totalLimit: settings.remediationQueueDeleteLimit,
  });

  // Anonymous reports are operational review records, not permanent user content. Pending reports
  // expire after 180 days and resolved audit records after 730 days; both paths share this bounded
  // delete batch so cleanup cannot turn into an unbounded maintenance invocation.
  const correctionReports = await cleanupProductCorrectionReports(env.DB, limit, now);

  // Fetch staging is operational crawl telemetry, so it follows the crawl-run retention horizon.
  // The FK cascade removes the per-page frontier rows with the terminal session. Active sessions are
  // never eligible, and the same bounded delete limit keeps retention from becoming a D1 CPU spike.
  const crawlFetchSessions = await deleteTerminalCrawlFetchSessions(env.DB, {
    finalizedBefore: crawlRunsBefore,
    limit,
  });

  const crawlRuns = await env.DB.prepare(`
    DELETE FROM crawl_runs
    WHERE id IN (
      SELECT id FROM crawl_runs WHERE started_at < ? ORDER BY started_at ASC LIMIT ?
    )
  `)
    .bind(crawlRunsBefore, limit)
    .run();

  const priceHistory = await env.DB.prepare(`
    DELETE FROM price_history
    WHERE id IN (
      SELECT id FROM price_history WHERE observed_at < ? ORDER BY observed_at ASC LIMIT ?
    )
  `)
    .bind(priceHistoryBefore, limit)
    .run();

  // Retiring the listings and the entities they emptied is one step: the second half is scoped to
  // what the first half touched, so it cannot be split without losing the scope.
  const retired = await retireInactiveListings(env.DB, {
    before: inactiveProductsBefore,
    limit,
  });

  const result: RetentionCleanupResult = {
    event: "retention_cleanup",
    at: now.toISOString(),
    deleted: {
      evidenceMetadata: changes(evidenceMetadata),
      productAuditExports: changes(productAuditExports),
      knowledgeCatalogExports: changes(knowledgeCatalogExports),
      dataQualityRuns: changes(dataQualityRuns),
      remediationQueue,
      correctionReports,
      crawlFetchSessions,
      crawlRuns: changes(crawlRuns),
      priceHistory: changes(priceHistory),
      inactiveProducts: retired.listings,
      emptySearchEntities: retired.entities,
    },
  };
  console.log(JSON.stringify(result));
  return result;
}
