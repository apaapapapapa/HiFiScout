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

/** A complete threshold set after applying optional per-shop configuration. */
export type ResolvedQualityThresholds = QualityThresholds;

/** Direct overrides for one shop. Shop selection belongs to the plugin capability boundary. */
export type QualityThresholdOverrides = Readonly<
  Partial<Record<QualityThresholdKey, Readonly<Partial<QualityThreshold>>>>
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

export function resolveQualityThresholds(
  overrides: QualityThresholdOverrides = {},
): ResolvedQualityThresholds {
  return Object.freeze({
    manufacturerUnknownRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.manufacturerUnknownRate,
      ...overrides.manufacturerUnknownRate,
    },
    categoryUnclassifiedRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.categoryUnclassifiedRate,
      ...overrides.categoryUnclassifiedRate,
    },
    identityUnresolvedRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.identityUnresolvedRate,
      ...overrides.identityUnresolvedRate,
    },
    inventoryUnknownRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.inventoryUnknownRate,
      ...overrides.inventoryUnknownRate,
    },
    modelMissingRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.modelMissingRate,
      ...overrides.modelMissingRate,
    },
    parserFailureRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.parserFailureRate,
      ...overrides.parserFailureRate,
    },
    itemCountDropRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.itemCountDropRate,
      ...overrides.itemCountDropRate,
    },
    evidenceCoverageRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.evidenceCoverageRate,
      ...overrides.evidenceCoverageRate,
    },
  });
}
