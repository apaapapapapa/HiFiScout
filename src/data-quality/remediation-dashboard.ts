import type { RemediationShopBaseline } from "./remediation-baseline.js";
import type { evaluateRemediationSlo } from "./remediation-slo.js";

export const REMEDIATION_DASHBOARD_LIMITS = Object.freeze({
  historySnapshots: 12,
  contributors: 10,
  identityMethods: 50,
});

export const REMEDIATION_DASHBOARD_METRICS = Object.freeze([
  "manufacturerUnknown",
  "categoryUnclassified",
  "identityCoverage",
  "identityUnresolved",
  "inventoryUnknown",
  "modelMissing",
  "evidenceCoverage",
] as const);

export type RemediationDashboardMetricKey = (typeof REMEDIATION_DASHBOARD_METRICS)[number];
export type RemediationTrendDirection = "improving" | "degrading" | "flat" | "unknown";

type RemediationSlo = ReturnType<typeof evaluateRemediationSlo>;

export interface DashboardQuality {
  id: number;
  evaluatedAt: string;
  remediationSlo: RemediationSlo;
}

export interface RemediationMetricTrendPoint {
  evaluatedAt: string;
  value: number | null;
  status: string;
}

export interface RemediationDashboardMetric {
  currentValue: number | null;
  threshold: number;
  comparison: "lt" | "gt" | "eq";
  status: string;
  met: boolean | null;
  previousValue: number | null;
  absoluteDelta: number | null;
  percentageDelta: number | null;
  trendDirection: RemediationTrendDirection;
  trend: RemediationMetricTrendPoint[];
  rolloutBaselineValue: number | null;
  rolloutAbsoluteDelta: number | null;
  rolloutPercentageDelta: number | null;
}

function delta(current: number | null, reference: number | null) {
  if (current == null || reference == null) {
    return { absoluteDelta: null, percentageDelta: null };
  }
  const absoluteDelta = current - reference;
  return {
    absoluteDelta,
    percentageDelta: reference === 0 ? null : absoluteDelta / Math.abs(reference),
  };
}

function direction(
  key: RemediationDashboardMetricKey,
  trend: readonly RemediationMetricTrendPoint[],
): RemediationTrendDirection {
  const known = trend.filter((point) => point.value != null);
  if (known.length < 2) return "unknown";
  const first = known[0]?.value;
  const last = known[known.length - 1]?.value;
  if (first == null || last == null) return "unknown";
  const change = last - first;
  if (Math.abs(change) < 1e-12) return "flat";
  const higherIsBetter = key === "identityCoverage" || key === "evidenceCoverage";
  return (change > 0) === higherIsBetter ? "improving" : "degrading";
}

export function buildRemediationDashboardMetric(
  key: RemediationDashboardMetricKey,
  current: DashboardQuality,
  historyNewestFirst: readonly DashboardQuality[],
  baselineValue: number | null,
): RemediationDashboardMetric {
  const metric = current.remediationSlo.metrics[key];
  const previous = historyNewestFirst.find((entry) => entry.id !== current.id);
  const previousValue = previous?.remediationSlo.metrics[key].rate ?? null;
  const trend = historyNewestFirst
    .slice(0, REMEDIATION_DASHBOARD_LIMITS.historySnapshots)
    .reverse()
    .map((entry) => ({
      evaluatedAt: entry.evaluatedAt,
      value: entry.remediationSlo.metrics[key].rate,
      status: entry.remediationSlo.metrics[key].status,
    }));
  const previousDelta = delta(metric.rate, previousValue);
  const rolloutDelta = delta(metric.rate, baselineValue);
  return {
    currentValue: metric.rate,
    threshold: metric.target,
    comparison: metric.comparison,
    status: metric.status,
    met: metric.met,
    previousValue,
    absoluteDelta: previousDelta.absoluteDelta,
    percentageDelta: previousDelta.percentageDelta,
    trendDirection: direction(key, trend),
    trend,
    rolloutBaselineValue: baselineValue,
    rolloutAbsoluteDelta: rolloutDelta.absoluteDelta,
    rolloutPercentageDelta: rolloutDelta.percentageDelta,
  };
}

export function buildRemediationDashboardMetrics(
  current: DashboardQuality,
  historyNewestFirst: readonly DashboardQuality[],
  baseline: RemediationShopBaseline | null,
): Record<RemediationDashboardMetricKey, RemediationDashboardMetric> {
  return Object.fromEntries(
    REMEDIATION_DASHBOARD_METRICS.map((key) => [
      key,
      buildRemediationDashboardMetric(key, current, historyNewestFirst, baseline?.[key] ?? null),
    ]),
  ) as Record<RemediationDashboardMetricKey, RemediationDashboardMetric>;
}
