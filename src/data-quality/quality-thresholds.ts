import type { QualityThreshold } from "../db/types.js";

/** The eight metric keys `DEFAULT_QUALITY_THRESHOLDS` declares. */
export type QualityThresholdKey =
  | "manufacturerUnknownRate"
  | "categoryUnclassifiedRate"
  | "identityUnresolvedRate"
  | "inventoryUnknownRate"
  | "modelMissingRate"
  | "parserFailureRate"
  | "itemCountDropRate"
  | "evidenceCoverageRate";

/** Shape of the frozen defaults: every declared key is present. */
export type QualityThresholds = Readonly<Record<QualityThresholdKey, QualityThreshold>>;

/**
 * Shape of a merged per-shop threshold set. `Object.fromEntries` cannot preserve the key
 * union, so the resolved map is string-keyed; it still holds exactly the eight default keys.
 */
export type ResolvedQualityThresholds = Readonly<Record<string, QualityThreshold>>;

/**
 * Per-shop overrides, keyed by shop key then by threshold key. Adapters supply a
 * `Record<string, Partial<QualityThreshold>>`, so the inner keys stay `string`.
 */
export type QualityThresholdOverrides = Readonly<
  Record<string, Readonly<Record<string, Partial<QualityThreshold>>>>
>;

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = Object.freeze({
  manufacturerUnknownRate: { warning: 0.02, critical: 0.05, direction: "high" },
  categoryUnclassifiedRate: { warning: 0.03, critical: 0.1, direction: "high" },
  identityUnresolvedRate: { warning: 0.2, critical: 0.4, direction: "high" },
  inventoryUnknownRate: { warning: 0.05, critical: 0.15, direction: "high" },
  modelMissingRate: { warning: 0.1, critical: 0.25, direction: "high" },
  parserFailureRate: { warning: 0.02, critical: 0.1, direction: "high" },
  itemCountDropRate: { warning: -0.2, critical: -0.5, direction: "low", inclusive: true },
  evidenceCoverageRate: { warning: 0.95, critical: 0.8, direction: "low", inclusive: false },
});

export function qualityThresholdsForShop(
  shopKey: string,
  overrides: QualityThresholdOverrides = {},
): ResolvedQualityThresholds {
  const shopOverrides = overrides?.[shopKey] || {};
  return Object.fromEntries(
    Object.entries(DEFAULT_QUALITY_THRESHOLDS).map(
      ([key, value]): [string, QualityThreshold] => [key, { ...value, ...shopOverrides[key] }],
    ),
  );
}
