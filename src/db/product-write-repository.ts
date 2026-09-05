/**
 * Listing write path: the crawler's `products` upsert and the lookups it needs.
 *
 * Deliberately separate from the read repositories. This module decides what counts as a change,
 * what counts as *user-facing* activity, and what may be skipped entirely; the search and history
 * repositories only project rows onto API contracts.
 */

import {
  UNCLASSIFIED_CATEGORY_ID,
  categoryIdForClassification,
  categorySearchAliases,
  isUnclassifiedCategoryId,
} from "../catalog/categories.js";
import {
  listingDirectCategoryIds,
  listingMembershipCategoryIds,
} from "../catalog/listing-components.js";
import { normalizeFeatureFacts } from "../catalog/product-features.js";
import { normalizeFacetFacts } from "../catalog/product-facets.js";
import { manufacturerIdForFilter, normalizeManufacturerKey } from "../catalog/manufacturers.js";
import { MANUFACTURER_RESOLVER_VERSION } from "../catalog/manufacturer-resolver.js";
import { MODEL_RESOLVER_VERSION } from "../catalog/model-resolver.js";
import { normalizeIdentityModel } from "../catalog/product-identity.js";
import type {
  CatalogProductUpsertInput,
  CategoryId,
  ClassificationStatus,
  FacetFact,
  FeatureFact,
  ManufacturerResolutionMethod,
  ManufacturerResolutionStatus,
  ModelResolutionMethod,
  ResolutionConfidence,
  ResolutionStatus,
  StockStatus,
} from "../catalog/types.js";
import {
  DEFAULT_PRODUCT_ACTIVITY_POLICY,
  type ProductActivityPolicy,
} from "./product-activity-policy.js";
import type {
  ExistingCategoryEnrichmentState,
  ExistingProductRow,
  ProductLookupRow,
  ProductPriceLookupRow,
  ProductRow,
  QueryableDatabase,
  ReadableDatabase,
  UpsertProductsResult,
} from "./types.js";

/** D1 caps bound variables per statement; every `IN (...)` lookup is chunked below that limit. */
const LOOKUP_CHUNK_SIZE = 50;
const RECENT_SOURCE_WINDOW_MS = 48 * 60 * 60 * 1000;

interface CatalogFields {
  rawManufacturer: string;
  normalizedRawManufacturer: string;
  manufacturerId: string;
  canonicalManufacturerId: string;
  manufacturerResolutionStatus: ManufacturerResolutionStatus;
  manufacturerResolutionMethod: ManufacturerResolutionMethod;
  manufacturerResolutionConfidence: ResolutionConfidence;
  manufacturerResolverVersion: number;
  rawModel: string;
  normalizedModel: string;
  presentationColor: string;
  modelResolutionStatus: ResolutionStatus;
  modelResolutionMethod: ModelResolutionMethod;
  modelResolutionConfidence: ResolutionConfidence;
  modelResolverVersion: number;
  rawCategory: string;
  primaryCategoryId: CategoryId;
  categoryIds: CategoryId[];
  categoryIdsJson: string;
  directCategoryIds: CategoryId[];
  directCategoryIdsJson: string;
  classificationStatus: ClassificationStatus;
  searchAliases: string;
  featureFacts: FeatureFact[];
  facetFacts: FacetFact[];
}

interface ExistingCatalogFields extends Omit<
  CatalogFields,
  "categoryIds" | "directCategoryIds" | "featureFacts" | "facetFacts"
> {}

interface InitialActivity {
  at: string;
  userFacing: boolean;
}

interface UpsertProductsOptions {
  deactivateMissing?: boolean;
  touchIntervalMinutes?: number;
  activityPolicy?: Readonly<ProductActivityPolicy>;
}

type ExistingProductWithOverrides = ExistingProductRow & {
  override_presentation_color?: string | null;
};

async function runBatches(
  db: QueryableDatabase,
  statements: D1PreparedStatement[],
  chunkSize = 50,
): Promise<number> {
  let changes = 0;
  for (let i = 0; i < statements.length; i += chunkSize) {
    const results = await db.batch(statements.slice(i, i + chunkSize));
    for (const result of results || []) changes += Number(result?.meta?.changes || 0);
  }
  return changes;
}

function catalogFields(product: CatalogProductUpsertInput): CatalogFields {
  // An unmapped seller category means "we could not decide", which is the sentinel — not the
  // `other` leaf a product can legitimately belong to.
  const categoryEvidence = [product.rawCategory, product.category, product.title]
    .filter(Boolean)
    .join(" ");
  const primaryCategoryId =
    categoryIdForClassification(
      product.primaryCategoryId || product.category || "",
      categoryEvidence,
    ) || UNCLASSIFIED_CATEGORY_ID;
  const categoryIds = [primaryCategoryId];
  // Re-normalized rather than trusted: this repository accepts a loose input, and a caller that
  // supplies nothing must still store the primary as the listing's one direct category.
  const directCategoryIds = listingDirectCategoryIds(
    product.directCategoryIds || [],
    primaryCategoryId,
  );
  const rawManufacturer = product.rawManufacturer ?? product.manufacturer ?? "";
  const canonicalManufacturerId =
    product.manufacturerResolutionStatus === "candidate" ||
    product.manufacturerResolutionStatus === "unresolved"
      ? ""
      : product.manufacturerId || "";
  const manufacturerResolutionStatus =
    product.manufacturerResolutionStatus || (canonicalManufacturerId ? "resolved" : "unresolved");
  const rawModel = product.rawModel ?? product.model ?? "";
  const normalizedModel = product.normalizedModel ?? normalizeIdentityModel(product.model);
  return {
    rawManufacturer,
    normalizedRawManufacturer:
      product.normalizedRawManufacturer ?? normalizeManufacturerKey(rawManufacturer),
    manufacturerId: product.manufacturerId || manufacturerIdForFilter(product.manufacturer),
    canonicalManufacturerId,
    manufacturerResolutionStatus,
    manufacturerResolutionMethod:
      product.manufacturerResolutionMethod ||
      (manufacturerResolutionStatus === "resolved" ? "bootstrap_alias" : "none"),
    manufacturerResolutionConfidence:
      product.manufacturerResolutionConfidence ||
      (manufacturerResolutionStatus === "resolved" ? "high" : "none"),
    manufacturerResolverVersion: MANUFACTURER_RESOLVER_VERSION,
    rawModel,
    normalizedModel,
    presentationColor: product.presentationColor ?? "",
    modelResolutionStatus:
      product.modelResolutionStatus || (normalizedModel ? "resolved" : "unresolved"),
    modelResolutionMethod:
      product.modelResolutionMethod || (normalizedModel ? "seller_model" : "none"),
    modelResolutionConfidence:
      product.modelResolutionConfidence || (normalizedModel ? "medium" : "none"),
    modelResolverVersion: product.modelResolverVersion || MODEL_RESOLVER_VERSION,
    rawCategory: product.rawCategory ?? product.category ?? "",
    primaryCategoryId,
    categoryIds,
    categoryIdsJson: JSON.stringify(categoryIds),
    directCategoryIds,
    directCategoryIdsJson: JSON.stringify(directCategoryIds),
    classificationStatus:
      product.classificationStatus ||
      (isUnclassifiedCategoryId(primaryCategoryId) ? "unclassified" : "classified"),
    searchAliases: product.searchAliases ?? categorySearchAliases(categoryIds),
    featureFacts: normalizeFeatureFacts(product.featureFacts || []),
    facetFacts: normalizeFacetFacts(product.facetFacts || []),
  };
}

/** Stored `direct_category_ids`, or nothing for a row written before the column existed. */
function parseStoredCategoryIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function existingCatalogFields(existing: ExistingProductRow): ExistingCatalogFields {
  // Same fallback as `catalogFields()`, so an unchanged row never looks changed to the diff below.
  const primaryCategoryId =
    categoryIdForClassification(
      existing.primary_category_id || existing.category,
      [existing.raw_category, existing.category, existing.title].filter(Boolean).join(" "),
    ) || UNCLASSIFIED_CATEGORY_ID;
  return {
    rawManufacturer: existing.raw_manufacturer ?? existing.manufacturer ?? "",
    normalizedRawManufacturer:
      existing.normalized_raw_manufacturer ||
      normalizeManufacturerKey(existing.raw_manufacturer ?? existing.manufacturer),
    manufacturerId: manufacturerIdForFilter(existing.manufacturer),
    canonicalManufacturerId:
      existing.manufacturer_resolution_status === "resolved"
        ? existing.canonical_manufacturer_id || manufacturerIdForFilter(existing.manufacturer)
        : "",
    manufacturerResolutionStatus:
      existing.manufacturer_resolution_status ||
      (existing.canonical_manufacturer_id ? "resolved" : "unresolved"),
    manufacturerResolutionMethod:
      existing.manufacturer_resolution_method ||
      (existing.canonical_manufacturer_id ? "bootstrap_alias" : "none"),
    manufacturerResolutionConfidence:
      existing.manufacturer_resolution_confidence ||
      (existing.canonical_manufacturer_id ? "high" : "none"),
    manufacturerResolverVersion:
      existing.manufacturer_resolver_version || MANUFACTURER_RESOLVER_VERSION,
    rawModel: existing.raw_model ?? existing.model ?? "",
    normalizedModel: existing.normalized_model || normalizeIdentityModel(existing.model),
    presentationColor: existing.presentation_color ?? "",
    modelResolutionStatus:
      existing.model_resolution_status || (existing.model ? "resolved" : "unresolved"),
    modelResolutionMethod:
      existing.model_resolution_method || (existing.model ? "seller_model" : "none"),
    modelResolutionConfidence:
      existing.model_resolution_confidence || (existing.model ? "medium" : "none"),
    modelResolverVersion: existing.model_resolver_version || MODEL_RESOLVER_VERSION,
    rawCategory: existing.raw_category ?? existing.category ?? "",
    primaryCategoryId,
    categoryIdsJson: JSON.stringify([primaryCategoryId]),
    // The one stored category column this function reads instead of reconstructing. A set's direct
    // categories cannot be re-derived from the primary, so reconstructing would report every set
    // listing as changed on every crawl; normalizing both sides through the same function is what
    // keeps a legacy or aliased stored value from looking like a change either.
    directCategoryIdsJson: JSON.stringify(
      listingDirectCategoryIds(
        parseStoredCategoryIds(existing.direct_category_ids),
        primaryCategoryId,
      ),
    ),
    classificationStatus:
      existing.classification_status ||
      (isUnclassifiedCategoryId(primaryCategoryId) ? "unclassified" : "classified"),
    searchAliases: existing.search_aliases ?? categorySearchAliases([primaryCategoryId]),
  };
}

function productSourcePublishedAt(product: CatalogProductUpsertInput): string | null {
  return product.sourcePublishedAt ?? null;
}

/**
 * A listing first seen long after the retailer published it is a backfill, not news: it is dated
 * by the retailer's timestamp and kept out of the "new arrivals" activity count.
 */
function initialActivity(product: CatalogProductUpsertInput, observedAt: string): InitialActivity {
  const sourceAt = productSourcePublishedAt(product);
  if (!sourceAt) return { at: observedAt, userFacing: true };
  const sourceMs = new Date(sourceAt).getTime();
  const observedMs = new Date(observedAt).getTime();
  if (!Number.isFinite(sourceMs) || !Number.isFinite(observedMs) || sourceMs > observedMs) {
    return { at: observedAt, userFacing: true };
  }
  if (observedMs - sourceMs > RECENT_SOURCE_WINDOW_MS) return { at: sourceAt, userFacing: false };
  return { at: observedAt, userFacing: true };
}

export async function selectProductsForHistory(
  db: QueryableDatabase,
  shopKey: string,
  sourceIds: readonly string[],
  chunkSize = LOOKUP_CHUNK_SIZE,
): Promise<ProductPriceLookupRow[]> {
  const uniqueIds = [...new Set(sourceIds)];
  const rows: ProductPriceLookupRow[] = [];
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT id, source_id, price_yen FROM products WHERE shop_key = ? AND source_id IN (${placeholders})`,
      )
      .bind(shopKey, ...chunk)
      .all<ProductPriceLookupRow>();
    rows.push(...(result.results || []));
  }
  return rows;
}

export async function selectExistingProducts(
  db: ReadableDatabase,
  shopKey: string,
  sourceIds: readonly string[],
  chunkSize = LOOKUP_CHUNK_SIZE,
): Promise<ExistingProductRow[]> {
  const uniqueIds = [...new Set(sourceIds)];
  const rows: ExistingProductRow[] = [];
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
      SELECT id, source_id, manufacturer, raw_manufacturer, manufacturer_id,
             normalized_raw_manufacturer, canonical_manufacturer_id,
             manufacturer_resolution_status, manufacturer_resolution_method,
             manufacturer_resolution_confidence, manufacturer_resolver_version,
             model, raw_model, normalized_model, presentation_color, model_resolution_status,
             model_resolution_method, model_resolution_confidence, model_resolver_version, title,
             category, raw_category, primary_category_id, category_ids, direct_category_ids,
             classification_status, search_aliases,
             condition_text, price_yen, stock_status, source_url, source_published_at, metadata_json,
             first_seen_at, last_seen_at, last_activity_at, is_active,
             (
               SELECT presentation_color
               FROM product_admin_overrides
               WHERE listing_product_id = products.id
             ) AS override_presentation_color
      FROM products WHERE shop_key = ? AND source_id IN (${placeholders})
    `)
      .bind(shopKey, ...chunk)
      .all<ExistingProductRow>();
    rows.push(...(result.results || []));
  }
  return rows;
}

/**
 * Existing listing state used only by category-enrichment cache and identity decisions.
 *
 * The upsert lookup above deliberately carries every column needed to decide whether a listing
 * write changed. Category enrichment needs ten of those columns and never reads price, stock,
 * activity, source-publishing or resolver state. It also does not consume the admin presentation
 * colour override, so this query must not inherit that correlated lookup merely because the write
 * path does.
 */
export async function selectExistingCategoryEnrichmentStates(
  db: ReadableDatabase,
  shopKey: string,
  sourceIds: readonly string[],
  chunkSize = LOOKUP_CHUNK_SIZE,
): Promise<ExistingCategoryEnrichmentState[]> {
  const uniqueIds = [...new Set(sourceIds)];
  const rows: ExistingCategoryEnrichmentState[] = [];
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT source_id, title, model, manufacturer_id, category, primary_category_id,
               category_ids, classification_status, search_aliases, metadata_json
        FROM products
        WHERE shop_key = ? AND source_id IN (${placeholders})
      `)
      .bind(shopKey, ...chunk)
      .all<ExistingCategoryEnrichmentState>();
    rows.push(...(result.results || []));
  }
  return rows;
}

export async function selectActiveProductSourceIds(
  db: QueryableDatabase,
  shopKey: string,
): Promise<string[]> {
  const result = await db
    .prepare("SELECT source_id FROM products WHERE shop_key = ? AND is_active = 1")
    .bind(shopKey)
    .all<Pick<ProductRow, "source_id">>();
  return (result.results || []).map((row) => row.source_id);
}

export async function deactivateProductsBySourceIds(
  db: QueryableDatabase,
  shopKey: string,
  sourceIds: readonly string[],
  chunkSize = LOOKUP_CHUNK_SIZE,
): Promise<number> {
  const uniqueIds = [...new Set(sourceIds)];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    statements.push(
      db
        .prepare(
          `UPDATE products SET is_active = 0 WHERE shop_key = ? AND is_active = 1 AND source_id IN (${placeholders})`,
        )
        .bind(shopKey, ...chunk),
    );
  }
  return runBatches(db, statements, chunkSize);
}

/** Any stored column differing from the freshly parsed listing, including re-normalized fields. */
function listingChanged(existing: ExistingProductRow, product: CatalogProductUpsertInput): boolean {
  const current = catalogFields(product);
  const previous = existingCatalogFields(existing);
  const overridePresentationColor = (existing as ExistingProductWithOverrides)
    .override_presentation_color;
  return (
    existing.manufacturer !== product.manufacturer ||
    previous.rawManufacturer !== current.rawManufacturer ||
    previous.normalizedRawManufacturer !== current.normalizedRawManufacturer ||
    previous.manufacturerId !== current.manufacturerId ||
    previous.canonicalManufacturerId !== current.canonicalManufacturerId ||
    previous.manufacturerResolutionStatus !== current.manufacturerResolutionStatus ||
    previous.manufacturerResolutionMethod !== current.manufacturerResolutionMethod ||
    previous.manufacturerResolutionConfidence !== current.manufacturerResolutionConfidence ||
    previous.manufacturerResolverVersion !== current.manufacturerResolverVersion ||
    existing.model !== product.model ||
    previous.rawModel !== current.rawModel ||
    previous.normalizedModel !== current.normalizedModel ||
    (overridePresentationColor == null &&
      previous.presentationColor !== current.presentationColor) ||
    previous.modelResolutionStatus !== current.modelResolutionStatus ||
    previous.modelResolutionMethod !== current.modelResolutionMethod ||
    previous.modelResolutionConfidence !== current.modelResolutionConfidence ||
    previous.modelResolverVersion !== current.modelResolverVersion ||
    existing.title !== product.title ||
    existing.category !== product.category ||
    previous.rawCategory !== current.rawCategory ||
    previous.primaryCategoryId !== current.primaryCategoryId ||
    previous.categoryIdsJson !== current.categoryIdsJson ||
    previous.directCategoryIdsJson !== current.directCategoryIdsJson ||
    previous.classificationStatus !== current.classificationStatus ||
    previous.searchAliases !== current.searchAliases ||
    existing.condition_text !== product.conditionText ||
    existing.price_yen !== product.priceYen ||
    existing.stock_status !== product.stockStatus ||
    existing.source_url !== product.sourceUrl ||
    (existing.source_published_at ?? null) !== productSourcePublishedAt(product) ||
    Number(existing.is_active) !== 1
  );
}

/** `unknown` is an absence of information, so transitions in or out of it are not news. */
function meaningfulStockActivity(previousStatus: StockStatus, currentStatus: StockStatus): boolean {
  if (previousStatus === currentStatus) return false;
  if (!previousStatus || !currentStatus) return false;
  if (previousStatus === "unknown" || currentStatus === "unknown") return false;
  return true;
}

/** The policy-selected subset of {@link listingChanged} that drives `last_activity_at`. */
function activityChanged(
  existing: ExistingProductRow,
  product: CatalogProductUpsertInput,
  policy: Readonly<ProductActivityPolicy>,
): boolean {
  const previous = existingCatalogFields(existing);
  const current = catalogFields(product);
  const priceChanged = existing.price_yen !== product.priceYen;
  const stockChanged = meaningfulStockActivity(existing.stock_status, product.stockStatus);
  const reactivated = Number(existing.is_active) !== 1;

  return (
    // `model` is derived and may move when resolver rules change. User-facing model activity is
    // seller evidence changing, so an empty raw model remains meaningful and is never replaced by
    // the title-derived model for this comparison.
    (policy.model && previous.rawModel !== current.rawModel) ||
    (policy.title && existing.title !== product.title) ||
    (policy.condition && existing.condition_text !== product.conditionText) ||
    (policy.price && priceChanged) ||
    (policy.stock && stockChanged) ||
    (policy.reactivation && reactivated)
  );
}

function categoriesChanged(
  existing: ExistingProductRow,
  product: CatalogProductUpsertInput,
): boolean {
  const current = catalogFields(product);
  const previous = existingCatalogFields(existing);
  return (
    previous.primaryCategoryId !== current.primaryCategoryId ||
    previous.categoryIdsJson !== current.categoryIdsJson ||
    previous.directCategoryIdsJson !== current.directCategoryIdsJson
  );
}

/** Unchanged listings still need an occasional `last_seen_at` heartbeat, but not every crawl. */
function shouldTouch(
  existing: ExistingProductRow,
  observedAt: string,
  touchIntervalMinutes: number,
): boolean {
  if (!existing.last_seen_at) return true;
  const observedMs = new Date(observedAt).getTime();
  const lastSeenMs = new Date(existing.last_seen_at).getTime();
  if (!Number.isFinite(observedMs) || !Number.isFinite(lastSeenMs)) return true;
  return observedMs - lastSeenMs >= touchIntervalMinutes * 60_000;
}

async function rowsForSources(
  db: QueryableDatabase,
  shopKey: string,
  sourceIds: readonly string[],
): Promise<ProductLookupRow[]> {
  const rows: ProductLookupRow[] = [];
  for (let i = 0; i < sourceIds.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = sourceIds.slice(i, i + LOOKUP_CHUNK_SIZE);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT id, source_id FROM products WHERE shop_key = ? AND source_id IN (${placeholders})`,
      )
      .bind(shopKey, ...chunk)
      .all<ProductLookupRow>();
    rows.push(...(result.results || []));
  }
  return rows;
}

async function syncProductCategories(
  db: QueryableDatabase,
  shopKey: string,
  products: readonly CatalogProductUpsertInput[],
  sourceIds: readonly string[],
): Promise<void> {
  if (!sourceIds.length) return;
  const wanted = new Set(sourceIds);
  const selected = products.filter((product) => wanted.has(product.sourceId));
  const rows = await rowsForSources(db, shopKey, sourceIds);
  const idBySource = new Map(rows.map((row) => [row.source_id, row.id]));
  const statements: D1PreparedStatement[] = [];
  for (const product of selected) {
    const productId = idBySource.get(product.sourceId);
    if (!productId) continue;
    const fields = catalogFields(product);
    const directIds = new Set<string>(fields.directCategoryIds);
    statements.push(
      db.prepare("DELETE FROM product_categories WHERE product_id = ?").bind(productId),
    );
    for (const categoryId of listingMembershipCategoryIds(
      fields.primaryCategoryId,
      fields.directCategoryIds,
    )) {
      statements.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO product_categories(product_id, category_id, is_direct) VALUES (?, ?, ?)",
          )
          .bind(productId, categoryId, directIds.has(categoryId) ? 1 : 0),
      );
    }
  }
  await runBatches(db, statements);
}

async function syncProductFeatureFacts(
  db: QueryableDatabase,
  shopKey: string,
  products: readonly CatalogProductUpsertInput[],
  sourceIds: readonly string[],
  observedAt: string,
): Promise<number> {
  if (!sourceIds.length) return 0;
  const wanted = new Set(sourceIds);
  const selected = products.filter((product) => wanted.has(product.sourceId));
  const rows = await rowsForSources(db, shopKey, sourceIds);
  const idBySource = new Map(rows.map((row) => [row.source_id, row.id]));
  const statements: D1PreparedStatement[] = [];
  let factCount = 0;
  for (const product of selected) {
    const productId = idBySource.get(product.sourceId);
    if (!productId) continue;
    // Only title-derived facts are owned by this pass; verified facts from other sources persist.
    const facts = catalogFields(product).featureFacts.filter((fact) => fact.source === "title");
    factCount += facts.length;
    statements.push(
      db
        .prepare("DELETE FROM product_feature_facts WHERE product_id = ? AND source = 'title'")
        .bind(productId),
    );
    for (const fact of facts) {
      statements.push(
        db
          .prepare(`
        INSERT OR REPLACE INTO product_feature_facts(product_id, feature_id, state, source, confidence, verified_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
          .bind(
            productId,
            fact.featureId,
            fact.state,
            fact.source,
            fact.confidence,
            fact.verifiedAt || observedAt,
          ),
      );
    }
  }
  await runBatches(db, statements);
  return factCount;
}

const CRAWL_OWNED_FACET_SOURCES = ["title", "seller_category", "legacy_category"] as const;

async function syncProductFacetFacts(
  db: QueryableDatabase,
  shopKey: string,
  products: readonly CatalogProductUpsertInput[],
  sourceIds: readonly string[],
  observedAt: string,
): Promise<void> {
  if (!sourceIds.length) return;
  const wanted = new Set(sourceIds);
  const selected = products.filter((product) => wanted.has(product.sourceId));
  const rows = await rowsForSources(db, shopKey, sourceIds);
  const idBySource = new Map(rows.map((row) => [row.source_id, row.id]));
  const statements: D1PreparedStatement[] = [];

  for (const product of selected) {
    const productId = idBySource.get(product.sourceId);
    if (!productId) continue;
    const facts = catalogFields(product).facetFacts;
    const placeholders = CRAWL_OWNED_FACET_SOURCES.map(() => "?").join(",");
    statements.push(
      db
        .prepare(
          `DELETE FROM product_facet_facts WHERE product_id = ? AND source IN (${placeholders})`,
        )
        .bind(productId, ...CRAWL_OWNED_FACET_SOURCES),
    );
    for (const fact of facts) {
      statements.push(
        db
          .prepare(`
        INSERT OR REPLACE INTO product_facet_facts(
          product_id, facet_id, facet_value, source, confidence, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
          .bind(
            productId,
            fact.facetId,
            fact.value,
            fact.source,
            fact.confidence,
            fact.verifiedAt || observedAt,
          ),
      );
    }
  }

  await runBatches(db, statements);
}

export async function upsertProducts(
  db: QueryableDatabase,
  shopKey: string,
  products: readonly CatalogProductUpsertInput[],
  observedAt: string,
  {
    deactivateMissing = false,
    touchIntervalMinutes = 1440,
    activityPolicy = DEFAULT_PRODUCT_ACTIVITY_POLICY,
  }: UpsertProductsOptions = {},
): Promise<UpsertProductsResult> {
  const existingRows = await selectExistingProducts(
    db,
    shopKey,
    products.map((product) => product.sourceId),
  );
  const existingBySource = new Map(existingRows.map((row) => [row.source_id, row]));
  const observedSourceIds = new Set(products.map((product) => product.sourceId));
  const missingSourceIds = deactivateMissing
    ? (await selectActiveProductSourceIds(db, shopKey)).filter(
        (sourceId) => !observedSourceIds.has(sourceId),
      )
    : [];
  const newSourceIds: string[] = [];
  const changedSourceIds: string[] = [];
  const changedPriceSourceIds: string[] = [];
  const categorySyncSourceIds: string[] = [];
  const featureSyncSourceIds: string[] = [];
  const facetSyncSourceIds: string[] = [];
  const writes: D1PreparedStatement[] = [];
  let changedCount = 0;
  let activityCount = 0;
  let touchedCount = 0;

  for (const product of products) {
    const fields = catalogFields(product);
    const existing = existingBySource.get(product.sourceId);
    if (!existing) {
      const firstActivity = initialActivity(product, observedAt);
      newSourceIds.push(product.sourceId);
      categorySyncSourceIds.push(product.sourceId);
      featureSyncSourceIds.push(product.sourceId);
      facetSyncSourceIds.push(product.sourceId);
      writes.push(
        db
          .prepare(`
        INSERT INTO products (
          shop_key, source_id, manufacturer, raw_manufacturer, normalized_raw_manufacturer,
          manufacturer_id, canonical_manufacturer_id, manufacturer_resolution_status,
          manufacturer_resolution_method, manufacturer_resolution_confidence,
          manufacturer_resolver_version, model, raw_model, normalized_model, presentation_color,
          model_resolution_status, model_resolution_method, model_resolution_confidence,
          model_resolver_version, title,
          category, raw_category, primary_category_id, category_ids, direct_category_ids,
          classification_status, search_aliases,
          condition_text, price_yen, previous_price_yen, stock_status, source_url, source_published_at,
          first_seen_at, last_seen_at, last_changed_at, last_activity_at, is_active
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1
        )
      `)
          .bind(
            shopKey,
            product.sourceId,
            product.manufacturer,
            fields.rawManufacturer,
            fields.normalizedRawManufacturer,
            fields.manufacturerId,
            fields.canonicalManufacturerId,
            fields.manufacturerResolutionStatus,
            fields.manufacturerResolutionMethod,
            fields.manufacturerResolutionConfidence,
            fields.manufacturerResolverVersion,
            product.model,
            fields.rawModel,
            fields.normalizedModel,
            fields.presentationColor,
            fields.modelResolutionStatus,
            fields.modelResolutionMethod,
            fields.modelResolutionConfidence,
            fields.modelResolverVersion,
            product.title,
            product.category,
            fields.rawCategory,
            fields.primaryCategoryId,
            fields.categoryIdsJson,
            fields.directCategoryIdsJson,
            fields.classificationStatus,
            fields.searchAliases,
            product.conditionText,
            product.priceYen,
            product.stockStatus,
            product.sourceUrl,
            productSourcePublishedAt(product),
            observedAt,
            observedAt,
            observedAt,
            firstActivity.at,
          ),
      );
      changedCount += 1;
      if (firstActivity.userFacing) activityCount += 1;
      continue;
    }

    const priceChanged = existing.price_yen !== product.priceYen && product.priceYen != null;
    const changed = listingChanged(existing, product);
    const hasActivity = activityChanged(existing, product, activityPolicy);
    if (priceChanged) changedPriceSourceIds.push(product.sourceId);
    if (categoriesChanged(existing, product)) categorySyncSourceIds.push(product.sourceId);
    if (existing.title !== product.title) featureSyncSourceIds.push(product.sourceId);
    if (
      existing.title !== product.title ||
      existing.category !== product.category ||
      (existing.raw_category ?? existing.category ?? "") !== fields.rawCategory
    ) {
      facetSyncSourceIds.push(product.sourceId);
    }

    if (changed) {
      // SQLite writes every index named by SET, including same-value assignments. Keep the
      // existing change/activity policy, but update only columns whose stored value must move.
      const values = {
        manufacturer: product.manufacturer,
        raw_manufacturer: fields.rawManufacturer,
        normalized_raw_manufacturer: fields.normalizedRawManufacturer,
        manufacturer_id: fields.manufacturerId,
        canonical_manufacturer_id: fields.canonicalManufacturerId,
        manufacturer_resolution_status: fields.manufacturerResolutionStatus,
        manufacturer_resolution_method: fields.manufacturerResolutionMethod,
        manufacturer_resolution_confidence: fields.manufacturerResolutionConfidence,
        manufacturer_resolver_version: fields.manufacturerResolverVersion,
        model: product.model,
        raw_model: fields.rawModel,
        normalized_model: fields.normalizedModel,
        presentation_color:
          (existing as ExistingProductWithOverrides).override_presentation_color ??
          fields.presentationColor,
        model_resolution_status: fields.modelResolutionStatus,
        model_resolution_method: fields.modelResolutionMethod,
        model_resolution_confidence: fields.modelResolutionConfidence,
        model_resolver_version: fields.modelResolverVersion,
        title: product.title,
        category: product.category,
        raw_category: fields.rawCategory,
        primary_category_id: fields.primaryCategoryId,
        category_ids: fields.categoryIdsJson,
        direct_category_ids: fields.directCategoryIdsJson,
        classification_status: fields.classificationStatus,
        search_aliases: fields.searchAliases,
        condition_text: product.conditionText,
        price_yen: product.priceYen,
        stock_status: product.stockStatus,
        source_url: product.sourceUrl,
        source_published_at: productSourcePublishedAt(product),
        last_seen_at: observedAt,
        last_activity_at: hasActivity ? observedAt : existing.last_activity_at,
        is_active: 1,
      } satisfies Partial<ExistingProductRow>;
      const columns = (Object.keys(values) as (keyof typeof values)[]).filter(
        (column) => existing[column] !== values[column],
      );
      const assignments = columns.map((column) => `${column} = ?`);
      if (priceChanged) assignments.push("previous_price_yen = price_yen");
      assignments.push("last_changed_at = ?");
      writes.push(
        db
          .prepare(`UPDATE products SET ${assignments.join(", ")} WHERE id = ?`)
          .bind(...columns.map((column) => values[column]), observedAt, existing.id),
      );
      changedCount += 1;
      changedSourceIds.push(product.sourceId);
      if (hasActivity) activityCount += 1;
    } else if (shouldTouch(existing, observedAt, touchIntervalMinutes)) {
      writes.push(
        db
          .prepare("UPDATE products SET last_seen_at = ? WHERE id = ?")
          .bind(observedAt, existing.id),
      );
      touchedCount += 1;
    }
  }

  await runBatches(db, writes);
  await syncProductCategories(db, shopKey, products, [...new Set(categorySyncSourceIds)]);
  const featureFactCount = await syncProductFeatureFacts(
    db,
    shopKey,
    products,
    [...new Set(featureSyncSourceIds)],
    observedAt,
  );
  await syncProductFacetFacts(db, shopKey, products, [...new Set(facetSyncSourceIds)], observedAt);

  // Ids are only known after the inserts land, so history is written in a second pass.
  const historySourceIds = [...new Set([...newSourceIds, ...changedPriceSourceIds])];
  if (historySourceIds.length) {
    const rows = await selectProductsForHistory(db, shopKey, historySourceIds);
    const historyWrites = rows
      .filter((row) => row.price_yen != null)
      .map((row) =>
        db
          .prepare(
            "INSERT INTO price_history (product_id, price_yen, observed_at) VALUES (?, ?, ?)",
          )
          .bind(row.id, row.price_yen, observedAt),
      );
    await runBatches(db, historyWrites);
  }
  const deactivatedCount = missingSourceIds.length
    ? await deactivateProductsBySourceIds(db, shopKey, missingSourceIds)
    : 0;
  // A listing that disappeared is never in `products`, so its retired membership has to be named
  // here or nothing downstream would know to stop counting the offer.
  const derivedSourceIds = [
    ...new Set([...newSourceIds, ...changedSourceIds, ...missingSourceIds]),
  ];
  return {
    changedCount,
    activityCount,
    touchedCount,
    deactivatedCount,
    featureFactCount,
    derivedSourceIds,
  };
}
