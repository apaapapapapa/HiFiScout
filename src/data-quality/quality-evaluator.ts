import type {
  ItemCountMetric,
  QualityCounts,
  QualityEvaluation,
  QualityMetric,
  QualityRunMetrics,
  QualitySnapshotMetrics,
  QualityStatus,
  QualityThreshold,
} from "../db/types.js";
import type { QualityThresholdOverrides } from "./quality-thresholds.js";
import { qualityThresholdsForShop } from "./quality-thresholds.js";

/** Every count is optional: callers pass whichever subset the crawl produced. */
export type QualityEvaluationInput = Partial<QualityCounts> & { shopKey?: string };

export interface EvaluateQualityOptions {
  thresholdOverrides?: QualityThresholdOverrides;
}

/** Any numeric-ish column or counter; `nonNegative` normalises the rest away. */
type CountInput = number | null | undefined;

const STATUS_RANK: Record<QualityStatus, number> = {
  unknown: 0,
  healthy: 1,
  warning: 2,
  critical: 3,
};

function nonNegative(value: CountInput): number {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function rate(count: CountInput, denominator: CountInput): number | null {
  const total = nonNegative(denominator);
  if (!total) return null;
  return nonNegative(count) / total;
}

export function statusForRate(value: number | null, threshold: QualityThreshold): QualityStatus {
  if (value == null || !Number.isFinite(value)) return "unknown";
  if (threshold.direction === "low") {
    const critical =
      threshold.inclusive === false ? value < threshold.critical : value <= threshold.critical;
    const warning =
      threshold.inclusive === false ? value < threshold.warning : value <= threshold.warning;
    if (critical) return "critical";
    if (warning) return "warning";
    return "healthy";
  }
  if (value >= threshold.critical) return "critical";
  if (value >= threshold.warning) return "warning";
  return "healthy";
}

function metric(
  count: CountInput,
  denominator: CountInput,
  threshold: QualityThreshold,
): QualityMetric {
  const value = rate(count, denominator);
  return {
    count: nonNegative(count),
    denominator: nonNegative(denominator),
    rate: value,
    status: statusForRate(value, threshold),
  };
}

function worstStatus(statuses: QualityStatus[]): QualityStatus {
  const known = statuses.filter((status) => status !== "unknown");
  if (!known.length) return "unknown";
  return known.reduce<QualityStatus>(
    (worst, status) => (STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst),
    "healthy",
  );
}

export function evaluateQuality(
  input: QualityEvaluationInput | null | undefined,
  { thresholdOverrides = {} }: EvaluateQualityOptions = {},
): QualityEvaluation {
  const shopKey = String(input?.shopKey || "");
  const thresholds = qualityThresholdsForShop(shopKey, thresholdOverrides);
  const totalItems = nonNegative(input?.totalItems);
  const manufacturerMissing = nonNegative(input?.manufacturerMissingCount);
  const manufacturerUnresolved = nonNegative(input?.manufacturerUnresolvedCount);
  const manufacturerUnknown = manufacturerMissing + manufacturerUnresolved;
  const identityMatched = nonNegative(input?.identityMatchedCount);
  const identityUnresolved = nonNegative(input?.identityUnresolvedCount);
  const identityTotal = identityMatched + identityUnresolved;
  const inventoryKnown = nonNegative(input?.inventoryKnownCount);
  const inventoryUnknown = nonNegative(input?.inventoryUnknownCount);
  const inventoryTotal = inventoryKnown + inventoryUnknown;
  const modelExpected = nonNegative(input?.modelExpectedCount);
  const modelMissing = nonNegative(input?.modelMissingCount);
  const parseAttempts = nonNegative(input?.parseAttemptCount);
  const parseFailures = nonNegative(input?.parseFailureCount);
  const evidenceExpected = nonNegative(input?.evidenceExpectedEventCount);
  const evidenceArchived = nonNegative(input?.evidenceArchivedEventCount);
  const previousItemCount =
    input?.previousItemCount == null || !Number.isFinite(Number(input.previousItemCount))
      ? null
      : Number(input.previousItemCount);
  const currentItemCount = nonNegative(input?.currentItemCount);
  const itemCountAbsoluteDifference =
    previousItemCount == null ? null : currentItemCount - previousItemCount;
  // `itemCountAbsoluteDifference` is non-null exactly when `previousItemCount` is, so the extra
  // guard only satisfies the checker; it never changes which branch runs.
  const itemCountChangeRate =
    previousItemCount != null && itemCountAbsoluteDifference != null && previousItemCount > 0
      ? itemCountAbsoluteDifference / previousItemCount
      : null;

  const itemCount: ItemCountMetric = {
    previous: previousItemCount,
    current: currentItemCount,
    absoluteDifference: itemCountAbsoluteDifference,
    changeRate: itemCountChangeRate,
    status: statusForRate(itemCountChangeRate, thresholds.itemCountDropRate),
  };

  const metrics: QualitySnapshotMetrics & QualityRunMetrics = {
    manufacturerUnknown: metric(
      manufacturerUnknown,
      totalItems,
      thresholds.manufacturerUnknownRate,
    ),
    categoryUnclassified: metric(
      input?.categoryUnclassifiedCount,
      totalItems,
      thresholds.categoryUnclassifiedRate,
    ),
    identityUnresolved: metric(
      identityUnresolved,
      identityTotal,
      thresholds.identityUnresolvedRate,
    ),
    inventoryUnknown: metric(inventoryUnknown, inventoryTotal, thresholds.inventoryUnknownRate),
    modelMissing: metric(modelMissing, modelExpected, thresholds.modelMissingRate),
    parserFailure: metric(parseFailures, parseAttempts, thresholds.parserFailureRate),
    evidenceCoverage: evidenceExpected
      ? {
          count: evidenceArchived,
          denominator: evidenceExpected,
          rate: rate(evidenceArchived, evidenceExpected),
          status: statusForRate(
            rate(evidenceArchived, evidenceExpected),
            thresholds.evidenceCoverageRate,
          ),
        }
      : { count: 0, denominator: 0, rate: null, status: "unknown" },
    itemCount,
  };

  const snapshotStatus = worstStatus([
    metrics.manufacturerUnknown.status,
    metrics.categoryUnclassified.status,
    metrics.identityUnresolved.status,
    metrics.inventoryUnknown.status,
    metrics.modelMissing.status,
  ]);
  const runStatus = worstStatus([
    metrics.parserFailure.status,
    metrics.itemCount.status,
    metrics.evidenceCoverage.status,
  ]);
  const status = worstStatus([snapshotStatus, runStatus]);

  return {
    shopKey,
    status,
    snapshot: {
      status: snapshotStatus,
      metrics: {
        manufacturerUnknown: metrics.manufacturerUnknown,
        categoryUnclassified: metrics.categoryUnclassified,
        identityUnresolved: metrics.identityUnresolved,
        inventoryUnknown: metrics.inventoryUnknown,
        modelMissing: metrics.modelMissing,
      },
    },
    run: {
      status: runStatus,
      metrics: {
        parserFailure: metrics.parserFailure,
        evidenceCoverage: metrics.evidenceCoverage,
        itemCount: metrics.itemCount,
      },
    },
    metrics,
    counts: {
      totalItems,
      manufacturerMissingCount: manufacturerMissing,
      manufacturerUnresolvedCount: manufacturerUnresolved,
      categoryUnclassifiedCount: nonNegative(input?.categoryUnclassifiedCount),
      otherCategoryCount: nonNegative(input?.otherCategoryCount),
      identityMatchedCount: identityMatched,
      identityUnresolvedCount: identityUnresolved,
      identityVetoCount: nonNegative(input?.identityVetoCount),
      identityCandidateCount: nonNegative(input?.identityCandidateCount),
      inventoryKnownCount: inventoryKnown,
      inventoryUnknownCount: inventoryUnknown,
      modelExpectedCount: modelExpected,
      modelExtractedCount: nonNegative(input?.modelExtractedCount),
      modelMissingCount: modelMissing,
      parseAttemptCount: parseAttempts,
      parseSuccessCount: nonNegative(input?.parseSuccessCount),
      parseFailureCount: parseFailures,
      evidenceExpectedEventCount: evidenceExpected,
      evidenceArchivedEventCount: evidenceArchived,
      evidenceArchiveFailureCount: nonNegative(input?.evidenceArchiveFailureCount),
      previousItemCount,
      currentItemCount,
      itemCountAbsoluteDifference,
      itemCountChangeRate,
    },
  };
}
