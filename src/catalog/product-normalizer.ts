import type {
  CatalogNormalizationInput,
  CategoryNormalizationConfig,
  CategoryClassifiableProduct,
  CategoryClassification,
  CategoryClassificationMetadata,
  CategoryClassificationMetadataOverrides,
  CategoryClassificationMetadataPatch,
  CategoryEvidenceInput,
  NormalizedCatalogProduct,
  ProductMetadata,
  WithCategoryClassification,
} from "./types.js";
import { isRecord } from "../types.js";
import { classifyCategoryEvidence, summarizeCategoryEvidence } from "./category-classifier.js";
import { collectListingCategoryEvidence } from "./category-evidence.js";
import { resolveManufacturer, MANUFACTURER_RESOLVER_VERSION } from "./manufacturer-resolver.js";
import { normalizeManufacturerKey } from "./manufacturers.js";
import { resolveModel, MODEL_RESOLVER_VERSION } from "./model-resolver.js";
import { inferFeatureFacts, normalizeFeatureFacts } from "./product-features.js";

const CLASSIFICATION_METADATA_VERSION = 5;

function clean(value: unknown = ""): string {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function classificationMetadata(
  classification: CategoryClassification,
  evidence: CategoryEvidenceInput[],
  existing: CategoryClassificationMetadataPatch = {},
): CategoryClassificationMetadata & Record<string, unknown> {
  return {
    ...existing,
    version: CLASSIFICATION_METADATA_VERSION,
    state: classification.classificationState,
    status: classification.classificationStatus,
    reason: classification.classificationReason,
    source: classification.classificationSource,
    categoryIds: classification.categoryIds,
    candidateCategoryIds: classification.candidateCategoryIds,
    evidence: summarizeCategoryEvidence(evidence),
  };
}

/**
 * Writes a classification onto a product, preserving every other field of the input.
 *
 * Called three times per product in the worst case: once from `normalizeCatalogProduct` with a
 * raw parse result, then again from the crawler's enricher with an already-normalized product,
 * hence the generic input.
 */
export function applyCategoryClassification<T extends CategoryClassifiableProduct>(
  product: T,
  classification: CategoryClassification,
  evidence: CategoryEvidenceInput[] = product.categoryEvidence || [],
  metadataPatch: CategoryClassificationMetadataOverrides = {},
): WithCategoryClassification<T> {
  const metadata: Record<string, unknown> = isRecord(product.metadata) ? product.metadata : {};
  // Deliberately array-permissive, unlike the `product.metadata` guard above: the original
  // JavaScript tested only `categoryClassification && typeof … === "object"`, so an array-valued
  // block was spread into the metadata patch as numeric string keys. Preserved verbatim.
  const rawPreviousClassification: unknown = metadata.categoryClassification;
  const previousClassification: Record<string, unknown> | readonly unknown[] =
    isRecord(rawPreviousClassification) || Array.isArray(rawPreviousClassification)
      ? rawPreviousClassification
      : {};
  return {
    ...product,
    primaryCategoryId: classification.primaryCategoryId,
    categoryIds: classification.categoryIds,
    category: classification.displayName,
    classificationStatus: classification.classificationStatus,
    classificationState: classification.classificationState,
    classificationReason: classification.classificationReason,
    classificationSource: classification.classificationSource,
    candidateCategoryIds: classification.candidateCategoryIds,
    searchAliases: classification.searchAliases,
    categoryEvidence: evidence,
    metadata: {
      ...metadata,
      categoryClassification: classificationMetadata(classification, evidence, {
        ...previousClassification,
        ...metadataPatch,
      }),
    },
  };
}

export function normalizeCatalogProduct(
  product: CatalogNormalizationInput,
  config: CategoryNormalizationConfig = {},
): NormalizedCatalogProduct {
  const rawManufacturer = clean(product.rawManufacturer ?? product.manufacturer ?? "");
  const manufacturerCandidate = clean(product.manufacturer || rawManufacturer);
  const rawCategory = clean(product.rawCategory ?? "");
  const manufacturer = resolveManufacturer({
    rawManufacturer,
    manufacturerCandidate,
    title: product.title,
  });
  const normalizedRawManufacturer = normalizeManufacturerKey(rawManufacturer);
  // Model Resolution runs after Manufacturer Resolution so it can remove verified brand
  // presentation tokens and fall back to title evidence only for a known manufacturer.
  const model = resolveModel({
    rawModel: product.rawModel ?? product.model ?? "",
    title: product.title,
    manufacturerId: manufacturer.canonicalManufacturerId,
  });
  const metadata: Record<string, unknown> = isRecord(product.metadata) ? product.metadata : {};
  const { evidence } = collectListingCategoryEvidence({
    rawCategory,
    title: product.title || "",
    hintedCategory: product.category || "",
    categoryMapping: config.categoryMapping || {},
    categoryPolicy: config.categoryPolicy,
  });
  const classification = classifyCategoryEvidence(evidence);
  const featureFacts = normalizeFeatureFacts([
    ...(Array.isArray(product.featureFacts) ? product.featureFacts : []),
    ...inferFeatureFacts(product.title || "", { source: "title", confidence: 0.8 }),
  ]);
  return applyCategoryClassification(
    {
      ...product,
      rawManufacturer,
      normalizedRawManufacturer,
      manufacturerId: manufacturer.canonicalManufacturerId,
      manufacturer: manufacturer.displayName,
      manufacturerResolutionStatus: manufacturer.status,
      manufacturerResolutionMethod: manufacturer.method,
      manufacturerResolutionConfidence: manufacturer.confidence,
      model: model.model,
      rawModel: model.rawModel,
      normalizedModel: model.normalizedModel,
      modelResolutionStatus: model.status,
      modelResolutionMethod: model.method,
      modelResolutionConfidence: model.confidence,
      rawCategory,
      featureFacts,
      metadata: {
        ...metadata,
        manufacturerNormalization: {
          version: MANUFACTURER_RESOLVER_VERSION,
          matchedAlias: manufacturer.matchedAlias,
          status: manufacturer.status,
          method: manufacturer.method,
          confidence: manufacturer.confidence,
          normalizedRawManufacturer,
          candidateManufacturerIds: manufacturer.candidateManufacturerIds,
        },
        modelNormalization: {
          version: MODEL_RESOLVER_VERSION,
          status: model.status,
          method: model.method,
          confidence: model.confidence,
          normalizedModel: model.normalizedModel,
          removedAnnotations: model.removedAnnotations,
          unclassifiedTokens: model.unclassifiedTokens,
        },
      } satisfies ProductMetadata,
    },
    classification,
    evidence,
  );
}

export function normalizeCatalogProducts(
  products: readonly CatalogNormalizationInput[],
  config: CategoryNormalizationConfig = {},
): NormalizedCatalogProduct[] {
  return products.map((product) => normalizeCatalogProduct(product, config));
}

export const CATEGORY_CLASSIFICATION_METADATA_VERSION = CLASSIFICATION_METADATA_VERSION;
