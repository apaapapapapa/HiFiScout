import { evaluateRemediationSlo } from "../data-quality/remediation-slo.js";
import { dataQualityStatus, listDataQualityHistory } from "./data-quality-repository.js";
import type { QueryableDatabase } from "./types.js";

type StoredQuality = Awaited<ReturnType<typeof dataQualityStatus>>["shops"][number];

function withRemediationSlo<T extends StoredQuality>(quality: T): T & {
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
 * Existing Phase 2 status plus the post-Phase-4 milestone evaluation for every shop independently.
 * The top-level Phase 2 status remains the worst shop, so a healthy source cannot hide a degraded
 * source and the remediation goals do not create a second monitoring datastore.
 */
export async function dataQualityStatusWithRemediationSlo(db: QueryableDatabase): Promise<
  Omit<Awaited<ReturnType<typeof dataQualityStatus>>, "shops"> & {
    shops: Array<ReturnType<typeof withRemediationSlo>>;
  }
> {
  const status = await dataQualityStatus(db);
  return { ...status, shops: status.shops.map(withRemediationSlo) };
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
