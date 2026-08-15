export interface RemediationBaselineRates {
  manufacturerUnknown: number;
  categoryUnclassified: number;
  identityCoverage: number;
  identityUnresolved: number;
  inventoryUnknown: number;
  modelMissing: number;
  evidenceCoverage: number | null;
}

export interface RemediationShopBaseline extends RemediationBaselineRates {
  totalItems: number;
}

/**
 * Production state immediately before the post-Phase-4 remediation rollout.
 *
 * These values are intentionally source-controlled rather than inferred from retained DQ history:
 * retention cleanup may eventually remove the original rows, while the comparison point must stay
 * stable for the life of this remediation program. The source is documented in
 * `docs/post-phase4-data-quality-baseline.md`.
 */
export const REMEDIATION_ROLLOUT_BASELINE = Object.freeze({
  capturedAt: "2026-08-14",
  sourceCommit: "d3959f00641ae5025b4ee8d795a82dc09e6867d1",
  global: {
    totalItems: 6933,
    manufacturerUnknown: 0.8315,
    categoryUnclassified: 0.5105,
    identityCoverage: 1,
    identityUnresolved: 0.985,
    inventoryUnknown: 0.0144,
    modelMissing: 0,
    evidenceCoverage: 1,
  } satisfies RemediationShopBaseline,
  shops: {
    audiounion: {
      totalItems: 122,
      manufacturerUnknown: 0.7213,
      categoryUnclassified: 0.7213,
      identityCoverage: 1,
      identityUnresolved: 0.9426,
      inventoryUnknown: 0,
      modelMissing: 0,
      evidenceCoverage: null,
    },
    formusic: {
      totalItems: 180,
      manufacturerUnknown: 0.7278,
      categoryUnclassified: 0.4944,
      identityCoverage: 1,
      identityUnresolved: 0.9611,
      inventoryUnknown: 0.0056,
      modelMissing: 0,
      evidenceCoverage: null,
    },
    "fujiya-avic": {
      totalItems: 1955,
      manufacturerUnknown: 0.8957,
      categoryUnclassified: 0.0854,
      identityCoverage: 1,
      identityUnresolved: 0.9923,
      inventoryUnknown: 0.0199,
      modelMissing: 0,
      evidenceCoverage: null,
    },
    hifido: {
      totalItems: 3622,
      manufacturerUnknown: 0.8252,
      categoryUnclassified: 0.6223,
      identityCoverage: 1,
      identityUnresolved: 0.9925,
      inventoryUnknown: 0.0157,
      modelMissing: 0,
      evidenceCoverage: null,
    },
    ippinkan: {
      totalItems: 728,
      manufacturerUnknown: 0.6937,
      categoryUnclassified: 0.9327,
      identityCoverage: 1,
      identityUnresolved: 0.9423,
      inventoryUnknown: 0,
      modelMissing: 0,
      evidenceCoverage: null,
    },
    shimamusen: {
      totalItems: 190,
      manufacturerUnknown: 0.9895,
      categoryUnclassified: 0.8684,
      identityCoverage: 1,
      identityUnresolved: 0.9895,
      inventoryUnknown: 0.0158,
      modelMissing: 0,
      evidenceCoverage: null,
    },
    "u-audio": {
      totalItems: 136,
      manufacturerUnknown: 0.8309,
      categoryUnclassified: 0.7132,
      identityCoverage: 1,
      identityUnresolved: 0.9706,
      inventoryUnknown: 0,
      modelMissing: 0,
      evidenceCoverage: null,
    },
  } satisfies Readonly<Record<string, RemediationShopBaseline>>,
});

export function remediationBaselineForShop(shopKey: string): RemediationShopBaseline | null {
  return REMEDIATION_ROLLOUT_BASELINE.shops[
    shopKey as keyof typeof REMEDIATION_ROLLOUT_BASELINE.shops
  ] ?? null;
}
