import { evaluateRemediationSlo } from "../data-quality/remediation-slo.js";
import { dataQualityStatus, listDataQualityHistory } from "./data-quality-repository.js";
import { dataQualityRemediationOperationalMetrics } from "./data-quality-remediation-metrics.js";
import type { QueryableDatabase } from "./types.js";

// Deliberately keyed off `listDataQualityHistory`, not `dataQualityStatus`: it is the narrower of
// the two stored-row shapes (no `trend`), so a status-endpoint shop row — which has `trend` — still
// satisfies this constraint. `withRemediationSlo` only reads `metrics`/`details` either way.
type StoredQuality = Awaited<ReturnType<typeof listDataQualityHistory>>[number];

function withRemediationSlo<T extends StoredQuality>(
  quality: T,
): T & {
  remediationSlo: ReturnType<typeof evaluateRemediationSlo>;
} {
  const totalItems = Number(quality.metrics.manufacturerUnknown.denominator || 0);
  const missingIdentityRows = Number(quality.details.identityResolutionMissingCount || 0);
  return {
    ...quality,
    remediationSlo: evaluateRemediationSlo({
      totalItems,
      identityResolutionRowCount: Math.max(0, totalItems - missingIdentityRows),
      manufacturerUnknownRate: quality.metrics.manufacturerUnknown.rate,
      categoryUnclassifiedRate: quality.metrics.categoryUnclassified.rate,
      identityUnresolvedRate: quality.metrics.identityUnresolved.rate,
      inventoryUnknownRate: quality.metrics.inventoryUnknown.rate,
      modelMissingRate: quality.metrics.modelMissing.rate,
      evidenceCoverageRate: quality.metrics.evidenceCoverage.rate,
    }),
  };
}

/**
 * Existing Phase 2 status plus the post-Phase-4 milestone evaluation for every shop independently,
 * and the remediation work queue's own backlog/failure health. The top-level Phase 2 status remains
 * the worst shop, so a healthy source cannot hide a degraded source, and the queue is a single
 * cross-shop view because its work items are not resolved into a shop until a job is claimed. None
 * of this creates a second monitoring datastore — it reads the same tables the sweep already writes.
 */
export async function dataQualityStatusWithRemediationSlo(db: QueryableDatabase): Promise<
  Omit<Awaited<ReturnType<typeof dataQualityStatus>>, "shops"> & {
    shops: Array<
      Awaited<ReturnType<typeof dataQualityStatus>>["shops"][number] & {
        remediationSlo: ReturnType<typeof evaluateRemediationSlo>;
      }
    >;
    remediationQueue: Awaited<ReturnType<typeof dataQualityRemediationOperationalMetrics>>;
  }
> {
  const [status, remediationQueue] = await Promise.all([
    dataQualityStatus(db),
    dataQualityRemediationOperationalMetrics(db),
  ]);
  return {
    ...status,
    shops: status.shops.map((quality) => withRemediationSlo(quality)),
    remediationQueue,
  };
}

/** History uses the same persisted Phase 2 rows, with milestone compliance derived at read time. */
export async function listDataQualityHistoryWithRemediationSlo(
  db: QueryableDatabase,
  shopKey: string,
  limit?: number,
): Promise<Array<ReturnType<typeof withRemediationSlo>>> {
  const history = await listDataQualityHistory(db, shopKey, limit);
  return history.map(withRemediationSlo);
}
