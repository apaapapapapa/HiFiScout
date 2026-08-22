import { classifyCategoryEvidence } from "../catalog/category-classifier.js";
import { resolveCategoryPolicy } from "../catalog/category-evidence.js";
import { knowledgeCatalogEvidence, knowledgeCatalogKey } from "../catalog/knowledge-catalog.js";
import {
  CATEGORY_CLASSIFICATION_METADATA_VERSION,
  applyCategoryClassification,
} from "../catalog/product-normalizer.js";
import { findVerifiedCatalogMatches } from "../db/knowledge-catalog-repository.js";
import { findManualVerifiedCategoryMatches } from "../db/manual-category-authority-repository.js";
import { selectExistingProducts } from "../db/product-write-repository.js";
import { categoryIdForClassification } from "../catalog/categories.js";
import { errorMessage, isRecord } from "../types.js";
import type {
  CategoryClassification,
  CategoryId,
  NormalizedCatalogProduct,
} from "../catalog/types.js";
import type { CategoryEnrichmentProductRow, ReadableDatabase } from "../db/types.js";
import type {
  CategoryEnrichmentResult,
  DetailHtmlFetcher,
  FetchHtmlPageOptions,
  ShopPlugin,
} from "./types.js";

type CategoryEnrichmentAdapter = Pick<ShopPlugin, "key" | "capabilities">;

interface EnrichProductCategoriesOptions {
  db: ReadableDatabase;
  adapter: CategoryEnrichmentAdapter;
  products: NormalizedCatalogProduct[];
  transport: DetailHtmlFetcher;
  fetchOptions: FetchHtmlPageOptions;
  now?: Date;
  existingRows?: CategoryEnrichmentProductRow[] | null;
}

function parseJson(value: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseCategoryIds(value: string): CategoryId[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => categoryIdForClassification(item))
          .filter((item): item is CategoryId => item !== null)
      : [];
  } catch {
    return [];
  }
}

function sameIdentity(
  existing: CategoryEnrichmentProductRow | undefined,
  product: NormalizedCatalogProduct,
): boolean {
  return (
    existing?.title === product.title &&
    (existing?.model || "") === (product.model || "") &&
    (existing?.manufacturer_id || "") === (product.manufacturerId || "")
  );
}

function classificationMetadata(
  existing: CategoryEnrichmentProductRow | undefined,
): Record<string, unknown> | null {
  const metadata = parseJson(existing?.metadata_json);
  const classification = metadata.categoryClassification;
  return isRecord(classification) ? classification : null;
}

function cachedClassification(
  existing: CategoryEnrichmentProductRow | undefined,
  product: NormalizedCatalogProduct,
): CategoryClassification | null {
  if (!existing) return null;
  if (!sameIdentity(existing, product)) return null;
  const metadata = classificationMetadata(existing);
  if (metadata?.version !== CATEGORY_CLASSIFICATION_METADATA_VERSION) return null;
  if (typeof metadata.detailCheckedAt !== "string" || !metadata.detailCheckedAt) return null;
  if (metadata.state !== "classified" || existing.classification_status !== "classified")
    return null;
  const categoryIds = parseCategoryIds(existing.category_ids);
  if (!categoryIds.length) return null;
  return {
    primaryCategoryId: categoryIdForClassification(existing.primary_category_id) || categoryIds[0],
    categoryIds,
    displayName: existing.category,
    classificationStatus: "classified",
    classificationState: "classified",
    classificationReason: "",
    classificationSource: "cached_detail",
    candidateCategoryIds: [],
    searchAliases: existing.search_aliases || "",
  };
}

function recentUnresolvedCheck(
  existing: CategoryEnrichmentProductRow | undefined,
  product: NormalizedCatalogProduct,
  cacheHours: number,
  now: Date,
): boolean {
  if (!existing) return false;
  if (!sameIdentity(existing, product)) return false;
  const metadata = classificationMetadata(existing);
  if (metadata?.version !== CATEGORY_CLASSIFICATION_METADATA_VERSION) return false;
  if (
    metadata.state === "classified" ||
    typeof metadata.detailCheckedAt !== "string" ||
    !metadata.detailCheckedAt
  )
    return false;
  const checkedAt = new Date(metadata.detailCheckedAt).getTime();
  if (!Number.isFinite(checkedAt)) return false;
  return now.getTime() - checkedAt < cacheHours * 60 * 60_000;
}

function withDetailCheckMetadata(
  product: NormalizedCatalogProduct,
  detailCheckedAt: string,
): NormalizedCatalogProduct {
  return {
    ...product,
    metadata: {
      ...product.metadata,
      categoryClassification: { ...product.metadata.categoryClassification, detailCheckedAt },
    },
  };
}

async function applyKnowledgeCatalogEvidence(
  db: ReadableDatabase,
  products: NormalizedCatalogProduct[],
  now: Date,
): Promise<{ products: NormalizedCatalogProduct[]; catalogMatches: number }> {
  const [matches, manualCategoryMatches] = await Promise.all([
    findVerifiedCatalogMatches(db, products),
    findManualVerifiedCategoryMatches(db, products),
  ]);
  let catalogMatches = 0;
  const catalogMatchedAt = now.toISOString();
  const updated = products.map((product) => {
    const key = knowledgeCatalogKey(product.manufacturerId, product.model);
    const match = matches.get(key) || manualCategoryMatches.get(key);
    const catalogEvidence = knowledgeCatalogEvidence(match);
    if (!match || !catalogEvidence.length) return product;
    catalogMatches += 1;
    const evidence = [...(product.categoryEvidence || []), ...catalogEvidence];
    const classification = classifyCategoryEvidence(evidence);
    return applyCategoryClassification(product, classification, evidence, {
      catalogProductId: match.id,
      catalogMatchType: match.matchType,
      catalogMatchedAt,
    });
  });
  return { products: updated, catalogMatches };
}

export async function enrichProductCategories({
  db,
  adapter,
  products,
  transport,
  fetchOptions,
  now = new Date(),
  existingRows = null,
}: EnrichProductCategoriesOptions): Promise<CategoryEnrichmentResult> {
  const catalog = await applyKnowledgeCatalogEvidence(db, products, now);
  const baseProducts = catalog.products;
  const extractor = adapter.capabilities.detailCategoryEvidence?.extract;
  if (typeof extractor !== "function") {
    return {
      products: baseProducts,
      catalogMatches: catalog.catalogMatches,
      detailRequests: 0,
      cacheHits: 0,
      enrichedCount: 0,
      unresolvedCount: baseProducts.filter(
        (product) => product.classificationStatus !== "classified",
      ).length,
    };
  }

  const policy = resolveCategoryPolicy(adapter.capabilities.catalog?.categoryPolicy);
  const unresolved = baseProducts.filter(
    (product) => product.classificationStatus !== "classified",
  );
  if (!unresolved.length) {
    return {
      products: baseProducts,
      catalogMatches: catalog.catalogMatches,
      detailRequests: 0,
      cacheHits: 0,
      enrichedCount: 0,
      unresolvedCount: 0,
    };
  }

  const rows =
    existingRows ??
    (await selectExistingProducts(
      db,
      adapter.key,
      unresolved.map((product) => product.sourceId),
    ));
  const existingBySourceId = new Map(rows.map((row) => [row.source_id, row]));
  const maxRequests = policy.enrichment.maxRequestsPerCrawl;
  const checkedAt = now.toISOString();
  let detailRequests = 0;
  let cacheHits = 0;
  let enrichedCount = 0;

  const enriched: NormalizedCatalogProduct[] = [];
  for (const product of baseProducts) {
    if (product.classificationStatus === "classified") {
      enriched.push(product);
      continue;
    }

    const existing = existingBySourceId.get(product.sourceId);
    const cached = cachedClassification(existing, product);
    if (cached) {
      cacheHits += 1;
      enrichedCount += 1;
      const metadata = classificationMetadata(existing);
      enriched.push(
        applyCategoryClassification(
          product,
          cached,
          product.categoryEvidence,
          typeof metadata?.detailCheckedAt === "string"
            ? { detailCheckedAt: metadata.detailCheckedAt }
            : {},
        ),
      );
      continue;
    }

    if (recentUnresolvedCheck(existing, product, policy.enrichment.cacheHours, now)) {
      cacheHits += 1;
      const detailCheckedAt = classificationMetadata(existing)?.detailCheckedAt;
      enriched.push(
        typeof detailCheckedAt === "string"
          ? withDetailCheckMetadata(product, detailCheckedAt)
          : product,
      );
      continue;
    }

    if (!product.sourceUrl || detailRequests >= maxRequests) {
      enriched.push(product);
      continue;
    }

    detailRequests += 1;
    try {
      const html = await transport.fetchHtmlPage(product.sourceUrl, fetchOptions);
      const detailEvidence = await extractor(html, product);
      const evidence = [
        ...(product.categoryEvidence || []),
        ...(Array.isArray(detailEvidence) ? detailEvidence : []),
      ];
      const classification = classifyCategoryEvidence(evidence);
      const updated = applyCategoryClassification(product, classification, evidence, {
        detailCheckedAt: checkedAt,
      });
      if (updated.classificationStatus === "classified") enrichedCount += 1;
      enriched.push(updated);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "category_detail_enrichment_failed",
          shopKey: adapter.key,
          sourceId: product.sourceId,
          message: errorMessage(error),
        }),
      );
      enriched.push(product);
    }
  }

  return {
    products: enriched,
    catalogMatches: catalog.catalogMatches,
    detailRequests,
    cacheHits,
    enrichedCount,
    unresolvedCount: enriched.filter((product) => product.classificationStatus !== "classified")
      .length,
  };
}
