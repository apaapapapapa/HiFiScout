import type {
  CatalogAdapterLike,
  CategoryClassifiableProduct,
  CategoryClassification,
  CategoryClassificationMetadata,
  CategoryClassificationMetadataOverrides,
  CategoryClassificationMetadataPatch,
  CategoryEvidenceInput,
  NormalizedCatalogProduct,
  ProductMetadata,
  ShopParsedProduct,
  WithCategoryClassification,
} from "./types.js";
import { isRecord } from "../types.js";
import { classifyCategoryEvidence, summarizeCategoryEvidence } from "./category-classifier.js";
import { collectListingCategoryEvidence } from "./category-evidence.js";
import { normalizeManufacturer } from "./manufacturers.js";
import { inferFeatureFacts, normalizeFeatureFacts } from "./product-features.js";

const CLASSIFICATION_METADATA_VERSION = 3;
const MANUFACTURER_NORMALIZATION_METADATA_VERSION = 1;

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
  product: ShopParsedProduct,
  adapter: CatalogAdapterLike = {},
): NormalizedCatalogProduct {
  const rawManufacturer = clean(product.rawManufacturer ?? product.manufacturer ?? "");
  const manufacturerCandidate = clean(product.manufacturer || rawManufacturer);
  const rawCategory = clean(product.rawCategory ?? "");
  const manufacturer = normalizeManufacturer(manufacturerCandidate);
  const metadata: Record<string, unknown> = isRecord(product.metadata) ? product.metadata : {};
  const { evidence } = collectListingCategoryEvidence({
    rawCategory,
    title: product.title || "",
    hintedCategory: product.category || "",
    categoryMapping: adapter.categoryMapping || {},
    adapter,
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
      manufacturerId: manufacturer.id,
      manufacturer: manufacturer.displayName,
      rawCategory,
      featureFacts,
      metadata: {
        ...metadata,
        manufacturerNormalization: {
          version: MANUFACTURER_NORMALIZATION_METADATA_VERSION,
          matchedAlias: manufacturer.matchedAlias,
        },
      } satisfies ProductMetadata,
    },
    classification,
    evidence,
  );
}

export function normalizeCatalogProducts(
  products: readonly ShopParsedProduct[],
  adapter: CatalogAdapterLike = {},
): NormalizedCatalogProduct[] {
  return products.map((product) => normalizeCatalogProduct(product, adapter));
}

export const CATEGORY_CLASSIFICATION_METADATA_VERSION = CLASSIFICATION_METADATA_VERSION;
