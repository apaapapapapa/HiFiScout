import {
  REMEDIATION_ROLLOUT_BASELINE,
  remediationBaselineForShop,
} from "../data-quality/remediation-baseline.js";
import {
  buildRemediationDashboardMetrics,
  REMEDIATION_DASHBOARD_LIMITS,
} from "../data-quality/remediation-dashboard.js";
import { evaluateRemediationSlo } from "../data-quality/remediation-slo.js";
import { dataQualityRemediationImpact } from "./data-quality-remediation-impact-repository.js";
import { dataQualityRemediationOperationalMetrics } from "./data-quality-remediation-metrics.js";
import { dataQualityStatus, listDataQualityHistory } from "./data-quality-repository.js";
import { listIdentityResolutionMethodDistribution } from "./data-quality-remediation-dashboard-repository.js";
import { listUnresolvedIdentityGroups } from "./knowledge-catalog-remediation-repository.js";
import type { QueryableDatabase } from "./types.js";

type StoredQuality = Awaited<ReturnType<typeof dataQualityStatus>>["shops"][number];

function withRemediationSlo<T extends StoredQuality>(quality: T) {
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

export async function dataQualityStatusWithRemediationSlo(db: QueryableDatabase) {
  const status = await dataQualityStatus(db);
  const current = status.shops.map(withRemediationSlo);
  const histories = await Promise.all(
    current.map(async (shop) =>
      (
        await listDataQualityHistory(db, shop.shop, REMEDIATION_DASHBOARD_LIMITS.historySnapshots)
      ).map(withRemediationSlo),
    ),
  );
  const [impact, catalogCandidateGroups, queue, identityResolutionMethods] = await Promise.all([
    dataQualityRemediationImpact(db, REMEDIATION_DASHBOARD_LIMITS.contributors),
    listUnresolvedIdentityGroups(db, REMEDIATION_DASHBOARD_LIMITS.contributors),
    dataQualityRemediationOperationalMetrics(db),
    listIdentityResolutionMethodDistribution(db),
  ]);
  const shops = current.map((shop, index) => ({
    ...shop,
    dashboard: {
      historyLimit: REMEDIATION_DASHBOARD_LIMITS.historySnapshots,
      trendOrder: "oldest_to_newest" as const,
      rolloutBaselineCapturedAt: REMEDIATION_ROLLOUT_BASELINE.capturedAt,
      metrics: buildRemediationDashboardMetrics(
        shop,
        histories[index] || [],
        remediationBaselineForShop(shop.shop),
      ),
    },
  }));
  return {
    ...status,
    shops,
    remediation: {
      rolloutBaseline: REMEDIATION_ROLLOUT_BASELINE,
      boundedQueries: REMEDIATION_DASHBOARD_LIMITS,
      queue,
      identityResolutionMethods,
      topContributors: { ...impact, catalogCandidateGroups },
    },
  };
}

export async function listDataQualityHistoryWithRemediationSlo(
  db: QueryableDatabase,
  shopKey: string,
  limit?: number,
): Promise<Array<ReturnType<typeof withRemediationSlo>>> {
  return (await listDataQualityHistory(db, shopKey, limit)).map(withRemediationSlo);
}
