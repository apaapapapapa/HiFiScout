import type { QualityStatus } from "../db/types.js";

export type RemediationSloComparison = "lt" | "gt" | "eq";

export interface RemediationSloTarget {
  target: number;
  comparison: RemediationSloComparison;
  structural?: boolean;
}

export interface RemediationSloMetric extends RemediationSloTarget {
  rate: number | null;
  met: boolean | null;
  status: QualityStatus;
}

export interface RemediationSloInput {
  totalItems: number;
  identityResolutionRowCount: number;
  manufacturerUnknownRate: number | null;
  categoryUnclassifiedRate: number | null;
  identityUnresolvedRate: number | null;
  inventoryUnknownRate: number | null;
  modelMissingRate: number | null;
  evidenceCoverageRate: number | null;
}

export const REMEDIATION_INITIAL_MILESTONE = Object.freeze({
  manufacturerUnknownRate: { target: 0.1, comparison: "lt" },
  categoryUnclassifiedRate: { target: 0.1, comparison: "lt" },
  identityCoverageRate: { target: 1, comparison: "eq", structural: true },
  identityUnresolvedRate: { target: 0.5, comparison: "lt" },
  inventoryUnknownRate: { target: 0.05, comparison: "lt" },
  modelMissingRate: { target: 0.05, comparison: "lt" },
  evidenceCoverageRate: { target: 0.95, comparison: "gt" },
} satisfies Readonly<Record<string, RemediationSloTarget>>);

/** Later tightening goals from the post-Phase-4 remediation skill; not deploy gates. */
export const REMEDIATION_NEXT_TARGETS = Object.freeze({
  manufacturerUnknownRate: 0.02,
  categoryUnclassifiedRate: 0.03,
  identityUnresolvedRate: 0.2,
});

function finiteRate(value: number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function targetMet(
  rate: number | null,
  target: number,
  comparison: RemediationSloComparison,
): boolean | null {
  if (rate == null) return null;
  if (comparison === "lt") return rate < target;
  if (comparison === "gt") return rate > target;
  return rate === target;
}

function metric(rateInput: number | null, target: RemediationSloTarget): RemediationSloMetric {
  const rate = finiteRate(rateInput);
  const met = targetMet(rate, target.target, target.comparison);
  return {
    ...target,
    rate,
    met,
    status: met == null ? "unknown" : met ? "healthy" : target.structural ? "critical" : "warning",
  };
}

function aggregateStatus(metrics: readonly RemediationSloMetric[]): QualityStatus {
  const known = metrics.map((item) => item.status).filter((status) => status !== "unknown");
  if (!known.length) return "unknown";
  if (known.includes("critical")) return "critical";
  if (known.includes("warning")) return "warning";
  return "healthy";
}

/**
 * Evaluate the remediation milestone against the same Phase 2 rates already stored in
 * `data_quality_runs`. Identity coverage is derived separately from the full active-listing
 * denominator so a missing required resolution row can never be hidden inside an unresolved rate.
 */
export function evaluateRemediationSlo(input: RemediationSloInput): {
  milestone: "initial";
  status: QualityStatus;
  structuralStatus: QualityStatus;
  sourceStatus: QualityStatus;
  metrics: {
    manufacturerUnknown: RemediationSloMetric;
    categoryUnclassified: RemediationSloMetric;
    identityCoverage: RemediationSloMetric;
    identityUnresolved: RemediationSloMetric;
    inventoryUnknown: RemediationSloMetric;
    modelMissing: RemediationSloMetric;
    evidenceCoverage: RemediationSloMetric;
  };
  nextTargets: typeof REMEDIATION_NEXT_TARGETS;
} {
  const totalItems = Math.max(0, Number(input.totalItems) || 0);
  const identityRows = Math.min(
    totalItems,
    Math.max(0, Number(input.identityResolutionRowCount) || 0),
  );
  const identityCoverageRate = totalItems ? identityRows / totalItems : null;

  const metrics = {
    manufacturerUnknown: metric(
      input.manufacturerUnknownRate,
      REMEDIATION_INITIAL_MILESTONE.manufacturerUnknownRate,
    ),
    categoryUnclassified: metric(
      input.categoryUnclassifiedRate,
      REMEDIATION_INITIAL_MILESTONE.categoryUnclassifiedRate,
    ),
    identityCoverage: metric(
      identityCoverageRate,
      REMEDIATION_INITIAL_MILESTONE.identityCoverageRate,
    ),
    identityUnresolved: metric(
      input.identityUnresolvedRate,
      REMEDIATION_INITIAL_MILESTONE.identityUnresolvedRate,
    ),
    inventoryUnknown: metric(
      input.inventoryUnknownRate,
      REMEDIATION_INITIAL_MILESTONE.inventoryUnknownRate,
    ),
    modelMissing: metric(input.modelMissingRate, REMEDIATION_INITIAL_MILESTONE.modelMissingRate),
    evidenceCoverage: metric(
      input.evidenceCoverageRate,
      REMEDIATION_INITIAL_MILESTONE.evidenceCoverageRate,
    ),
  };
  const structuralStatus = aggregateStatus([metrics.identityCoverage]);
  const sourceStatus = aggregateStatus([
    metrics.manufacturerUnknown,
    metrics.categoryUnclassified,
    metrics.identityUnresolved,
    metrics.inventoryUnknown,
    metrics.modelMissing,
    metrics.evidenceCoverage,
  ]);

  return {
    milestone: "initial",
    status: aggregateStatus(Object.values(metrics)),
    structuralStatus,
    sourceStatus,
    metrics,
    nextTargets: REMEDIATION_NEXT_TARGETS,
  };
}
