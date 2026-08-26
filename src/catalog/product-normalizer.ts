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
import {
  componentCategoryIds,
  detectListingComponents,
  listingCategorySet,
} from "./listing-components.js";
import { resolveManufacturer, MANUFACTURER_RESOLVER_VERSION } from "./manufacturer-resolver.js";
import { manufacturerIdForFilter, normalizeManufacturerKey } from "./manufacturers.js";
import { presentationColorLabel } from "./model-presentation-color.js";
import { resolveModel, MODEL_RESOLVER_VERSION } from "./model-resolver.js";
import { inferFeatureFacts, normalizeFeatureFacts } from "./product-features.js";

const CLASSIFICATION_METADATA_VERSION = 14;

export interface CatalogNormalizationContext {
  /** Source seller used by narrowly scoped model-annotation rules. */
  readonly shopKey?: string;
}

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
  // Recomputed here rather than in `normalizeCatalogProduct` because the crawler's enricher applies
  // a second, better classification later; deriving the set from whichever classification is being
  // written keeps the two answers from drifting apart.
  const categorySet = listingCategorySet(classification, product.componentCategoryIds || []);
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
    primaryCategoryId: categorySet.primaryCategoryId,
    // Still the single-product classification result, deliberately: requirement 3 of the issue is
    // that this field does not quietly become the set. `directCategoryIds` is the set.
    categoryIds: categorySet.categoryIds,
    directCategoryIds: categorySet.directCategoryIds,
    category: categorySet.displayName,
    classificationStatus: categorySet.classificationStatus,
    classificationState: categorySet.classificationState,
    classificationReason: categorySet.classificationReason,
    classificationSource: categorySet.classificationSource,
    candidateCategoryIds: classification.candidateCategoryIds,
    searchAliases: categorySet.searchAliases,
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
  context: CatalogNormalizationContext = {},
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
    shopKey: context.shopKey,
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
  // Read from the same seller evidence the model resolver saw, so a set is detected from the text
  // the seller actually wrote rather than from anything this pipeline has already rewritten.
  const components = detectListingComponents(
    { rawModel: product.rawModel ?? product.model ?? "", title: product.title },
    { manufacturerId: manufacturer.canonicalManufacturerId, shopKey: context.shopKey },
  );
  const featureFacts = normalizeFeatureFacts([
    ...(Array.isArray(product.featureFacts) ? product.featureFacts : []),
    ...inferFeatureFacts(product.title || "", { source: "title", confidence: 0.8 }),
  ]);
  return applyCategoryClassification(
    {
      ...product,
      rawManufacturer,
      normalizedRawManufacturer,
      manufacturerId: manufacturerIdForFilter(manufacturer.displayName || rawManufacturer),
      manufacturer: manufacturer.displayName,
      manufacturerResolutionStatus: manufacturer.status,
      manufacturerResolutionMethod: manufacturer.method,
      manufacturerResolutionConfidence: manufacturer.confidence,
      model: model.model,
      rawModel: model.rawModel,
      normalizedModel: model.normalizedModel,
      presentationColor: presentationColorLabel(model.presentationColors),
      modelResolutionStatus: model.status,
      modelResolutionMethod: model.method,
      modelResolutionConfidence: model.confidence,
      rawCategory,
      featureFacts,
      componentCategoryIds: componentCategoryIds(components.components),
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
          presentationColors: model.presentationColors,
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
  context: CatalogNormalizationContext = {},
): NormalizedCatalogProduct[] {
  return products.map((product) => normalizeCatalogProduct(product, config, context));
}

export const CATEGORY_CLASSIFICATION_METADATA_VERSION = CLASSIFICATION_METADATA_VERSION;
