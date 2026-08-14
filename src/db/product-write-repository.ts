/**
 * Listing write path: the crawler's `products` upsert and the lookups it needs.
 *
 * Deliberately separate from the read repositories. This module decides what counts as a change,
 * what counts as *user-facing* activity, and what may be skipped entirely; the search and history
 * repositories only project rows onto API contracts.
 */

import {
  categoryClosureIds,
  categoryIdForFilter,
  categorySearchAliases,
} from "../catalog/categories.js";
import { normalizeFeatureFacts } from "../catalog/product-features.js";
import { manufacturerIdForFilter } from "../catalog/manufacturers.js";
import type {
  CatalogProductUpsertInput,
  CategoryId,
  ClassificationStatus,
  FeatureFact,
  StockStatus,
} from "../catalog/types.js";
import {
  DEFAULT_PRODUCT_ACTIVITY_POLICY,
  type ProductActivityPolicy,
} from "./product-activity-policy.js";
import type {
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
  manufacturerId: string;
  rawCategory: string;
  primaryCategoryId: CategoryId;
  categoryIds: CategoryId[];
  categoryIdsJson: string;
  classificationStatus: ClassificationStatus;
  searchAliases: string;
  featureFacts: FeatureFact[];
}

interface ExistingCatalogFields extends Omit<CatalogFields, "categoryIds" | "featureFacts"> {}

interface InitialActivity {
  at: string;
  userFacing: boolean;
}

interface UpsertProductsOptions {
  deactivateMissing?: boolean;
  touchIntervalMinutes?: number;
  activityPolicy?: Readonly<ProductActivityPolicy>;
}

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
  const primaryCategoryId =
    categoryIdForFilter(product.primaryCategoryId || product.category || "") || "other";
  const categoryIds = [primaryCategoryId];
  return {
    rawManufacturer: product.rawManufacturer ?? product.manufacturer ?? "",
    manufacturerId: product.manufacturerId || manufacturerIdForFilter(product.manufacturer),
    rawCategory: product.rawCategory ?? product.category ?? "",
    primaryCategoryId,
    categoryIds,
    categoryIdsJson: JSON.stringify(categoryIds),
    classificationStatus:
      product.classificationStatus ||
      (primaryCategoryId === "other" ? "unclassified" : "classified"),
    searchAliases: product.searchAliases ?? categorySearchAliases(categoryIds),
    featureFacts: normalizeFeatureFacts(product.featureFacts || []),
  };
}

function existingCatalogFields(existing: ExistingProductRow): ExistingCatalogFields {
  const primaryCategoryId =
    categoryIdForFilter(existing.primary_category_id || existing.category) || "other";
  return {
    rawManufacturer: existing.raw_manufacturer ?? existing.manufacturer ?? "",
    manufacturerId: existing.manufacturer_id || manufacturerIdForFilter(existing.manufacturer),
    rawCategory: existing.raw_category ?? existing.category ?? "",
    primaryCategoryId,
    categoryIdsJson: JSON.stringify([primaryCategoryId]),
    classificationStatus:
      existing.classification_status ||
      (primaryCategoryId === "other" ? "unclassified" : "classified"),
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
      SELECT id, source_id, manufacturer, raw_manufacturer, manufacturer_id, model, title,
             category, raw_category, primary_category_id, category_ids, classification_status, search_aliases,
             condition_text, price_yen, stock_status, source_url, source_published_at, metadata_json,
             first_seen_at, last_seen_at, last_activity_at, is_active
      FROM products WHERE shop_key = ? AND source_id IN (${placeholders})
    `)
      .bind(shopKey, ...chunk)
      .all<ExistingProductRow>();
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
  return (
    existing.manufacturer !== product.manufacturer ||
    previous.rawManufacturer !== current.rawManufacturer ||
    previous.manufacturerId !== current.manufacturerId ||
    existing.model !== product.model ||
    existing.title !== product.title ||
    existing.category !== product.category ||
    previous.rawCategory !== current.rawCategory ||
    previous.primaryCategoryId !== current.primaryCategoryId ||
    previous.categoryIdsJson !== current.categoryIdsJson ||
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
  const priceChanged = existing.price_yen !== product.priceYen;
  const stockChanged = meaningfulStockActivity(existing.stock_status, product.stockStatus);
  const reactivated = Number(existing.is_active) !== 1;

  return (
    (policy.model && existing.model !== product.model) ||
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
    previous.categoryIdsJson !== current.categoryIdsJson
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
    statements.push(
      db.prepare("DELETE FROM product_categories WHERE product_id = ?").bind(productId),
    );
    for (const categoryId of categoryClosureIds(fields.primaryCategoryId)) {
      statements.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO product_categories(product_id, category_id) VALUES (?, ?)",
          )
          .bind(productId, categoryId),
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
    // Only title-derived facts are owned by this pass; verified facts from other sources persist.
    const facts = catalogFields(product).featureFacts.filter((fact) => fact.source === "title");
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
  const changedPriceSourceIds: string[] = [];
  const categorySyncSourceIds: string[] = [];
  const featureSyncSourceIds: string[] = [];
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
      writes.push(
        db
          .prepare(`
        INSERT INTO products (
          shop_key, source_id, manufacturer, raw_manufacturer, manufacturer_id, model, title,
          category, raw_category, primary_category_id, category_ids, classification_status, search_aliases,
          condition_text, price_yen, previous_price_yen, stock_status, source_url, source_published_at,
          first_seen_at, last_seen_at, last_changed_at, last_activity_at, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1)
      `)
          .bind(
            shopKey,
            product.sourceId,
            product.manufacturer,
            fields.rawManufacturer,
            fields.manufacturerId,
            product.model,
            product.title,
            product.category,
            fields.rawCategory,
            fields.primaryCategoryId,
            fields.categoryIdsJson,
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

    if (changed) {
      writes.push(
        db
          .prepare(`
        UPDATE products SET
          manufacturer = ?, raw_manufacturer = ?, manufacturer_id = ?, model = ?, title = ?,
          category = ?, raw_category = ?, primary_category_id = ?, category_ids = ?,
          classification_status = ?, search_aliases = ?, condition_text = ?,
          previous_price_yen = CASE WHEN ? THEN price_yen ELSE previous_price_yen END,
          price_yen = ?, stock_status = ?, source_url = ?, source_published_at = ?, last_seen_at = ?, last_changed_at = ?,
          last_activity_at = CASE WHEN ? THEN ? ELSE last_activity_at END, is_active = 1
        WHERE id = ?
      `)
          .bind(
            product.manufacturer,
            fields.rawManufacturer,
            fields.manufacturerId,
            product.model,
            product.title,
            product.category,
            fields.rawCategory,
            fields.primaryCategoryId,
            fields.categoryIdsJson,
            fields.classificationStatus,
            fields.searchAliases,
            product.conditionText,
            priceChanged ? 1 : 0,
            product.priceYen,
            product.stockStatus,
            product.sourceUrl,
            productSourcePublishedAt(product),
            observedAt,
            observedAt,
            hasActivity ? 1 : 0,
            observedAt,
            existing.id,
          ),
      );
      changedCount += 1;
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
  await syncProductFeatureFacts(
    db,
    shopKey,
    products,
    [...new Set(featureSyncSourceIds)],
    observedAt,
  );

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
  return { changedCount, activityCount, touchedCount, deactivatedCount };
}
