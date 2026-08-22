import { getMaintenanceSettings } from "./config.js";
import type { CrawlerEnv, MaintenanceSettings } from "./crawler/types.js";
import type { QueryableDatabase } from "./db/types.js";

/** `runRetentionCleanup` always writes, so the database binding is required here. */
export interface RetentionEnv extends CrawlerEnv {
  readonly DB: QueryableDatabase;
}

export interface RetentionCutoffs {
  settings: MaintenanceSettings;
  crawlRunsBefore: string;
  dataQualityBefore: string;
  priceHistoryBefore: string;
  inactiveProductsBefore: string;
}

export interface RetentionCleanupCounts {
  evidenceMetadata: number;
  productAuditExports: number;
  knowledgeCatalogExports: number;
  dataQualityRuns: number;
  remediationQueue: number;
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
    priceHistoryBefore: cutoffIso(now, settings.priceHistoryRetentionDays),
    inactiveProductsBefore: cutoffIso(now, settings.inactiveProductRetentionDays),
  };
}

function changes(result: D1Response): number {
  return Number(result?.meta?.changes || 0);
}

export async function runRetentionCleanup(
  env: RetentionEnv,
  { now = new Date() }: { now?: Date } = {},
): Promise<RetentionCleanupResult> {
  const {
    settings,
    crawlRunsBefore,
    dataQualityBefore,
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

  // Completed remediation jobs are operational history, not a permanent per-listing ledger. Keep
  // failures for diagnosis, but age successful jobs out with the same retention horizon as DQ runs.
  const remediationQueue = await env.DB.prepare(`
    DELETE FROM data_quality_remediation_queue
    WHERE id IN (
      SELECT id FROM data_quality_remediation_queue
      WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < ?
      ORDER BY resolved_at ASC, id ASC
      LIMIT ?
    )
  `)
    .bind(dataQualityBefore, limit)
    .run();

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

  const inactiveProducts = await env.DB.prepare(`
    DELETE FROM products
    WHERE id IN (
      SELECT id FROM products
      WHERE is_active = 0 AND last_seen_at < ?
      ORDER BY last_seen_at ASC
      LIMIT ?
    )
  `)
    .bind(inactiveProductsBefore, limit)
    .run();

  // Deleting a listing cascades its search membership away, which can leave a product entity with
  // nothing to offer. Retiring those here keeps the read model's "every entity has an active
  // offer" invariant true without waiting for the next crawl of an unrelated shop.
  const emptySearchEntities = await env.DB.prepare(`
    DELETE FROM product_search_entities
    WHERE NOT EXISTS (
      SELECT 1 FROM product_search_entity_offers m WHERE m.entity_id = product_search_entities.id
    )
  `).run();

  const result: RetentionCleanupResult = {
    event: "retention_cleanup",
    at: now.toISOString(),
    deleted: {
      evidenceMetadata: changes(evidenceMetadata),
      productAuditExports: changes(productAuditExports),
      knowledgeCatalogExports: changes(knowledgeCatalogExports),
      dataQualityRuns: changes(dataQualityRuns),
      remediationQueue: changes(remediationQueue),
      crawlRuns: changes(crawlRuns),
      priceHistory: changes(priceHistory),
      inactiveProducts: changes(inactiveProducts),
      emptySearchEntities: changes(emptySearchEntities),
    },
  };
  console.log(JSON.stringify(result));
  return result;
}
