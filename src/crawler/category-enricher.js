import { classifyCategoryEvidence } from "../catalog/category-classifier.js";
import { resolveCategoryPolicy } from "../catalog/category-evidence.js";
import { knowledgeCatalogEvidence, knowledgeCatalogKey } from "../catalog/knowledge-catalog.js";
import {
  CATEGORY_CLASSIFICATION_METADATA_VERSION,
  applyCategoryClassification,
} from "../catalog/product-normalizer.js";
import { findVerifiedCatalogMatches } from "../db/knowledge-catalog-repository.js";
import { selectExistingProducts } from "../db/products.js";

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseCategoryIds(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function sameIdentity(existing, product) {
  return (
    existing?.title === product.title &&
    (existing?.model || "") === (product.model || "") &&
    (existing?.manufacturer_id || "") === (product.manufacturerId || "")
  );
}

function classificationMetadata(existing) {
  const metadata = parseJson(existing?.metadata_json, {});
  const classification = metadata.categoryClassification;
  return classification && typeof classification === "object" ? classification : null;
}

function cachedClassification(existing, product) {
  if (!sameIdentity(existing, product)) return null;
  const metadata = classificationMetadata(existing);
  if (metadata?.version !== CATEGORY_CLASSIFICATION_METADATA_VERSION) return null;
  if (!metadata.detailCheckedAt) return null;
  if (metadata.state !== "classified" || existing.classification_status !== "classified")
    return null;
  const categoryIds = parseCategoryIds(existing.category_ids);
  if (!categoryIds.length) return null;
  return {
    primaryCategoryId: existing.primary_category_id || categoryIds[0],
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

function recentUnresolvedCheck(existing, product, cacheHours, now) {
  if (!sameIdentity(existing, product)) return false;
  const metadata = classificationMetadata(existing);
  if (metadata?.version !== CATEGORY_CLASSIFICATION_METADATA_VERSION) return false;
  if (metadata.state === "classified" || !metadata.detailCheckedAt) return false;
  const checkedAt = new Date(metadata.detailCheckedAt).getTime();
  if (!Number.isFinite(checkedAt)) return false;
  return now.getTime() - checkedAt < cacheHours * 60 * 60_000;
}

function withDetailCheckMetadata(product, detailCheckedAt) {
  const classification = product.metadata?.categoryClassification || {};
  return {
    ...product,
    metadata: {
      ...(product.metadata || {}),
      categoryClassification: {
        ...classification,
        detailCheckedAt,
      },
    },
  };
}

async function applyKnowledgeCatalogEvidence(db, products, now) {
  const matches = await findVerifiedCatalogMatches(db, products);
  let catalogMatches = 0;
  const catalogMatchedAt = now.toISOString();
  const updated = products.map((product) => {
    const match = matches.get(knowledgeCatalogKey(product.manufacturerId, product.model));
    const catalogEvidence = knowledgeCatalogEvidence(match);
    if (!catalogEvidence.length) return product;
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
}) {
  const catalog = await applyKnowledgeCatalogEvidence(db, products, now);
  const baseProducts = catalog.products;
  const extractor = adapter?.extractDetailCategoryEvidence;
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

  const policy = resolveCategoryPolicy(adapter);
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

  const enriched = [];
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
      enriched.push(
        applyCategoryClassification(product, cached, product.categoryEvidence, {
          detailCheckedAt: classificationMetadata(existing)?.detailCheckedAt,
        }),
      );
      continue;
    }

    if (recentUnresolvedCheck(existing, product, policy.enrichment.cacheHours, now)) {
      cacheHits += 1;
      enriched.push(
        withDetailCheckMetadata(product, classificationMetadata(existing)?.detailCheckedAt),
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
      const detailEvidence = await extractor.call(adapter, html, product);
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
          message: error?.message || String(error),
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
