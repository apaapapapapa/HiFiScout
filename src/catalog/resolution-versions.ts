import { MANUFACTURER_RESOLVER_VERSION } from "./manufacturer-resolver.js";
import { MODEL_RESOLVER_VERSION } from "./model-resolver.js";
import { CATEGORY_CLASSIFICATION_METADATA_VERSION } from "./product-normalizer.js";

/**
 * Version tuple for deterministic replay eligibility.
 *
 * Manufacturer/model versions stay owned by their resolvers. Category already persists its
 * classifier version in `metadata_json.categoryClassification.version`. Identity had no durable
 * algorithm version before the post-Phase-4 remediation work, so it starts at 1 here.
 */
export const CATEGORY_CLASSIFIER_VERSION = CATEGORY_CLASSIFICATION_METADATA_VERSION;
export const IDENTITY_RESOLVER_VERSION = 2;

export const RESOLUTION_VERSIONS = Object.freeze({
  manufacturer: MANUFACTURER_RESOLVER_VERSION,
  model: MODEL_RESOLVER_VERSION,
  category: CATEGORY_CLASSIFIER_VERSION,
  identity: IDENTITY_RESOLVER_VERSION,
});

/** Stages whose stored version participates in automatic replay eligibility. */
export type ResolutionStage = keyof typeof RESOLUTION_VERSIONS;
