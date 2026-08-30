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
  CategoryEvidenceInput,
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

/** The identity {@link sameIdentity} compares against, as a map key. */
function identityKey(product: NormalizedCatalogProduct): string {
  return JSON.stringify([product.manufacturerId || "", product.model || "", product.title]);
}

function groupByIdentity(
  products: readonly NormalizedCatalogProduct[],
): Map<string, NormalizedCatalogProduct[]> {
  const groups = new Map<string, NormalizedCatalogProduct[]>();
  for (const product of products) {
    const key = identityKey(product);
    const group = groups.get(key);
    if (group) group.push(product);
    else groups.set(key, [product]);
  }
  return groups;
}

/** What one crawl decided about a product identity, shared by every listing of that product. */
interface DetailDecision {
  /** Detail-page evidence restored from a copy classified on an earlier crawl. */
  cachedEvidence: CategoryEvidenceInput[] | null;
  /** Legacy cached rows may have the final classification but no persisted evidence summary. */
  cachedClassification: CategoryClassification | null;
  cachedCheckedAt: string | null;
  /** A recent detail check that found nothing; the whole identity waits out `cacheHours`. */
  recentlyChecked: boolean;
  recentCheckedAt: string | null;
  /** Evidence this crawl fetched for the identity, or null when no request was made. */
  detailEvidence: CategoryEvidenceInput[] | null;
}

function newDetailDecision(): DetailDecision {
  return {
    cachedEvidence: null,
    cachedClassification: null,
    cachedCheckedAt: null,
    recentlyChecked: false,
    recentCheckedAt: null,
    detailEvidence: null,
  };
}

function classificationMetadata(
  existing: CategoryEnrichmentProductRow | undefined,
): Record<string, unknown> | null {
  const metadata = parseJson(existing?.metadata_json);
  const classification = metadata.categoryClassification;
  return isRecord(classification) ? classification : null;
}

/**
 * Restore the persisted final answer for backward compatibility with cache rows that predate the
 * evidence summary. New cache rows should use {@link cachedDetailEvidence} so each listing can
 * recompute against its own seller evidence.
 */
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
    confidence: Math.max(0, Math.min(1, Number(metadata.confidence) || 1)),
  };
}

/**
 * Restore only the detail-page evidence from a cached decision.
 *
 * A cached final classification is not portable between listings: each listing still owns its
 * seller evidence. Sharing the final answer skipped that recomputation and also rewrote the
 * sibling's metadata without the detail evidence that justified the answer. Persisted metadata
 * already stores a normalized evidence summary, so replaying its `detail_*` items gives the cache
 * path the same semantics as a fresh detail fetch.
 */
function cachedDetailEvidence(
  existing: CategoryEnrichmentProductRow | undefined,
  product: NormalizedCatalogProduct,
): CategoryEvidenceInput[] | null {
  if (!cachedClassification(existing, product)) return null;
  const metadata = classificationMetadata(existing);
  if (!Array.isArray(metadata?.evidence)) return null;

  const detailEvidence = metadata.evidence
    .filter(isRecord)
    .filter((item) => typeof item.source === "string" && item.source.startsWith("detail_"))
    .map((item): CategoryEvidenceInput => ({
      categoryIds: Array.isArray(item.categoryIds)
        ? item.categoryIds.filter((value): value is string => typeof value === "string")
        : [],
      source: String(item.source),
      strength: typeof item.strength === "string" ? item.strength : "supporting",
      value: typeof item.value === "string" ? item.value : "",
    }))
    .filter((item) => Boolean(item.categoryIds?.length));
  return detailEvidence.length ? detailEvidence : null;
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

  // Decide once per product identity, not once per listing. Shops re-list the same stock under
  // several source ids, and the detail budget used to be spent walking listings in crawl order, so
  // copies before the cut-off were classified from their detail page while identical copies after
  // it stayed unclassified. That made the stored category a function of crawl position rather than
  // of the product, and the two answers then survived side by side in D1.
  const decisions = new Map<string, DetailDecision>();
  for (const [key, group] of groupByIdentity(unresolved)) {
    const decision = newDetailDecision();
    decisions.set(key, decision);

    for (const product of group) {
      const existing = existingBySourceId.get(product.sourceId);
      const cached = cachedClassification(existing, product);
      if (!cached) continue;
      decision.cachedClassification = cached;
      decision.cachedEvidence = cachedDetailEvidence(existing, product);
      const detailCheckedAt = classificationMetadata(existing)?.detailCheckedAt;
      decision.cachedCheckedAt = typeof detailCheckedAt === "string" ? detailCheckedAt : null;
      break;
    }
    if (decision.cachedClassification) continue;

    for (const product of group) {
      const existing = existingBySourceId.get(product.sourceId);
      if (!recentUnresolvedCheck(existing, product, policy.enrichment.cacheHours, now)) continue;
      const detailCheckedAt = classificationMetadata(existing)?.detailCheckedAt;
      decision.recentlyChecked = true;
      decision.recentCheckedAt = typeof detailCheckedAt === "string" ? detailCheckedAt : null;
      break;
    }
    if (decision.recentlyChecked) continue;

    // Any copy answers for the identity: they share title, model and manufacturer, which is all
    // the extractor keys off.
    const target = group.find((product) => product.sourceUrl);
    if (!target || detailRequests >= maxRequests) continue;

    detailRequests += 1;
    try {
      const html = await transport.fetchHtmlPage(target.sourceUrl, fetchOptions);
      const detailEvidence = await extractor(html, target);
      decision.detailEvidence = Array.isArray(detailEvidence) ? detailEvidence : [];
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "category_detail_enrichment_failed",
          shopKey: adapter.key,
          sourceId: target.sourceId,
          message: errorMessage(error),
        }),
      );
    }
  }

  const enriched: NormalizedCatalogProduct[] = [];
  for (const product of baseProducts) {
    if (product.classificationStatus === "classified") {
      enriched.push(product);
      continue;
    }
    const decision = decisions.get(identityKey(product));

    if (decision?.cachedClassification) {
      cacheHits += 1;
      if (decision.cachedEvidence) {
        const evidence = [...(product.categoryEvidence || []), ...decision.cachedEvidence];
        const classification = {
          ...classifyCategoryEvidence(evidence),
          classificationSource: "cached_detail",
        };
        const updated = applyCategoryClassification(
          product,
          classification,
          evidence,
          decision.cachedCheckedAt ? { detailCheckedAt: decision.cachedCheckedAt } : {},
        );
        if (updated.classificationStatus === "classified") enrichedCount += 1;
        enriched.push(updated);
      } else {
        // Legacy cache rows did not persist evidence. Keep their previous zero-request behaviour;
        // once a row is refreshed under the current metadata shape it will take the evidence path
        // above and regain per-listing recomputation plus full provenance.
        enrichedCount += 1;
        enriched.push(
          applyCategoryClassification(
            product,
            decision.cachedClassification,
            product.categoryEvidence,
            decision.cachedCheckedAt ? { detailCheckedAt: decision.cachedCheckedAt } : {},
          ),
        );
      }
      continue;
    }

    if (decision?.recentlyChecked) {
      cacheHits += 1;
      enriched.push(
        decision.recentCheckedAt
          ? withDetailCheckMetadata(product, decision.recentCheckedAt)
          : product,
      );
      continue;
    }

    // Detail evidence belongs to the identity, but it is still combined with each listing's own
    // seller evidence: two copies that really do carry different seller categories stay free to
    // classify differently, while identical copies cannot.
    if (decision?.detailEvidence) {
      const evidence = [...(product.categoryEvidence || []), ...decision.detailEvidence];
      const classification = classifyCategoryEvidence(evidence);
      const updated = applyCategoryClassification(product, classification, evidence, {
        detailCheckedAt: checkedAt,
      });
      if (updated.classificationStatus === "classified") enrichedCount += 1;
      enriched.push(updated);
      continue;
    }

    enriched.push(product);
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
