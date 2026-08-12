export const DEFAULT_QUALITY_THRESHOLDS = Object.freeze({
  manufacturerUnknownRate: { warning: 0.02, critical: 0.05, direction: "high" },
  categoryUnclassifiedRate: { warning: 0.03, critical: 0.1, direction: "high" },
  identityUnresolvedRate: { warning: 0.2, critical: 0.4, direction: "high" },
  inventoryUnknownRate: { warning: 0.05, critical: 0.15, direction: "high" },
  modelMissingRate: { warning: 0.1, critical: 0.25, direction: "high" },
  parserFailureRate: { warning: 0.02, critical: 0.1, direction: "high" },
  itemCountDropRate: { warning: -0.2, critical: -0.5, direction: "low", inclusive: true },
  evidenceCoverageRate: { warning: 0.95, critical: 0.8, direction: "low", inclusive: false },
});

export function qualityThresholdsForShop(shopKey, overrides = {}) {
  const shopOverrides = overrides?.[shopKey] || {};
  return Object.fromEntries(
    Object.entries(DEFAULT_QUALITY_THRESHOLDS).map(([key, value]) => [
      key,
      { ...value, ...shopOverrides[key] },
    ]),
  );
}
