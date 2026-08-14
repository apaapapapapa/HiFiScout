import {
  categoryClosureIds,
  categoryIdForFilter,
  categorySearchAliases,
} from "../catalog/categories.js";
import { isFeatureId, normalizeFeatureFacts } from "../catalog/product-features.js";
import { manufacturerIdForFilter } from "../catalog/manufacturers.js";
import type {
  CatalogProductUpsertInput,
  CategoryId,
  ClassificationStatus,
  FeatureFact,
  StockStatus,
} from "../catalog/types.js";
import { isRecord } from "../types.js";
import type {
  ExistingProductRow,
  ListProductsResult,
  PriceHistoryPoint,
  ProductApiRow,
  ProductHistoryResult,
  ProductListCursor,
  ProductLookupRow,
  ProductPriceLookupRow,
  ProductQuerySort,
  ProductRow,
  QueryableDatabase,
  ReadableDatabase,
  SortDefinition,
  UpsertProductsResult,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
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

function productRow(row: ProductRow): ProductApiRow;
function productRow(row: null): null;
function productRow(row: ProductRow | null): ProductApiRow | null {
  if (!row) return row;
  let categoryIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.category_ids || "[]");
    categoryIds = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    categoryIds = row.primary_category_id ? [row.primary_category_id] : [];
  }
  return { ...row, category_ids: categoryIds };
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

function meaningfulStockActivity(previousStatus: StockStatus, currentStatus: StockStatus): boolean {
  if (previousStatus === currentStatus) return false;
  if (!previousStatus || !currentStatus) return false;
  if (previousStatus === "unknown" || currentStatus === "unknown") return false;
  return true;
}

function activityChanged(
  existing: ExistingProductRow,
  product: CatalogProductUpsertInput,
): boolean {
  return (
    existing.model !== product.model ||
    existing.title !== product.title ||
    existing.condition_text !== product.conditionText ||
    existing.price_yen !== product.priceYen ||
    meaningfulStockActivity(existing.stock_status, product.stockStatus) ||
    Number(existing.is_active) !== 1
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
  { deactivateMissing = false, touchIntervalMinutes = 1440 }: UpsertProductsOptions = {},
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
    const hasActivity = activityChanged(existing, product);
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

function encodeCursor(payload: ProductListCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(value: string | null): ProductListCursor | null {
  if (!value) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(normalized + padding);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(parsed) || !Number.isInteger(parsed.id) || typeof parsed.sort !== "string")
      return null;
    return {
      id: Number(parsed.id),
      sort: parsed.sort,
      ...(typeof parsed.value === "string" ||
      typeof parsed.value === "number" ||
      parsed.value === null
        ? { value: parsed.value }
        : {}),
      ...(typeof parsed.isNull === "boolean" ? { isNull: parsed.isNull } : {}),
    };
  } catch {
    return null;
  }
}

function ftsPhrase(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sortDefinition(sortKey: string | null): SortDefinition {
  const definitions: Readonly<Record<ProductQuerySort, SortDefinition>> = {
    newest: { key: "newest", column: "last_activity_at", direction: "DESC", idDirection: "DESC" },
    oldest: { key: "oldest", column: "last_activity_at", direction: "ASC", idDirection: "ASC" },
    updated: {
      key: "updated",
      column: "last_activity_at",
      direction: "DESC",
      idDirection: "DESC",
    },
    priceAsc: {
      key: "priceAsc",
      column: "price_yen",
      direction: "ASC",
      idDirection: "ASC",
      price: true,
    },
    priceDesc: {
      key: "priceDesc",
      column: "price_yen",
      direction: "DESC",
      idDirection: "DESC",
      price: true,
    },
  };
  return sortKey && sortKey in definitions
    ? definitions[sortKey as ProductQuerySort]
    : definitions.newest;
}

function addCursorPredicate(
  where: string[],
  binds: unknown[],
  sort: SortDefinition,
  cursor: ProductListCursor | null,
): void {
  if (!cursor || cursor.sort !== sort.key) return;
  if (!sort.price) {
    if (typeof cursor.value !== "string") return;
    const op = sort.direction === "DESC" ? "<" : ">";
    const idOp = sort.idDirection === "DESC" ? "<" : ">";
    where.push(`(p.${sort.column} ${op} ? OR (p.${sort.column} = ? AND p.id ${idOp} ?))`);
    binds.push(cursor.value, cursor.value, cursor.id);
    return;
  }
  const idOp = sort.idDirection === "DESC" ? "<" : ">";
  if (cursor.isNull) {
    where.push(`(p.price_yen IS NULL AND p.id ${idOp} ?)`);
    binds.push(cursor.id);
    return;
  }
  if (typeof cursor.value !== "number") return;
  const priceOp = sort.direction === "DESC" ? "<" : ">";
  where.push(
    `(p.price_yen IS NULL OR p.price_yen ${priceOp} ? OR (p.price_yen = ? AND p.id ${idOp} ?))`,
  );
  binds.push(cursor.value, cursor.value, cursor.id);
}

function cursorFor(row: ProductApiRow, sort: SortDefinition): string {
  return encodeCursor({
    sort: sort.key,
    id: row.id,
    value: row[sort.column],
    isNull: sort.price ? row.price_yen == null : false,
  });
}

function requestedFeatures(params: URLSearchParams): string[] {
  return [
    ...new Set(
      params
        .getAll("feature")
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export function validateProductQuery(url: URL): string | null {
  const params = url.searchParams;
  const limits = { q: 100, shop: 80, manufacturer: 100, category: 100, cursor: 1024 };
  for (const [key, maxLength] of Object.entries(limits)) {
    const value = params.get(key);
    if (value != null && [...value].length > maxLength) return `${key}_too_long`;
  }
  for (const value of params.getAll("feature"))
    if ([...value].length > 200) return "feature_too_long";
  if (requestedFeatures(params).some((feature) => !isFeatureId(feature))) return "feature_invalid";
  for (const key of ["minPrice", "maxPrice", "limit", "offset"]) {
    const value = params.get(key);
    if (value != null && !/^\d{1,12}$/.test(value)) return `${key}_invalid`;
  }
  for (const key of ["inStock", "newOnly", "priceDropped", "includeTotal"]) {
    const value = params.get(key);
    if (value != null && value !== "true" && value !== "false") return `${key}_invalid`;
  }
  const sort = params.get("sort");
  if (sort && !["newest", "oldest", "updated", "priceAsc", "priceDesc"].includes(sort))
    return "sort_invalid";
  return null;
}

export async function listProducts(db: QueryableDatabase, url: URL): Promise<ListProductsResult> {
  const params = url.searchParams;
  const where: string[] = ["p.is_active = 1"];
  const binds: unknown[] = [];
  const q = params.get("q")?.trim();
  let join = "";
  if (q) {
    const terms = q.split(/\s+/u).filter(Boolean);
    if (terms.length === 1 && [...q].length >= 3) {
      join = "JOIN products_fts ON products_fts.rowid = p.id";
      where.push("products_fts MATCH ?");
      binds.push(ftsPhrase(q));
    } else {
      for (const value of terms) {
        where.push(
          `(p.title LIKE ? OR p.manufacturer LIKE ? OR p.raw_manufacturer LIKE ? OR p.model LIKE ? OR p.category LIKE ? OR p.raw_category LIKE ? OR p.search_aliases LIKE ?)`,
        );
        const term = `%${value}%`;
        binds.push(term, term, term, term, term, term, term);
      }
    }
  }
  const shop = params.get("shop")?.trim();
  if (shop) {
    where.push("p.shop_key = ?");
    binds.push(shop);
  }
  const manufacturer = params.get("manufacturer")?.trim();
  if (manufacturer) {
    where.push("(p.manufacturer_id = ? OR p.manufacturer = ?)");
    binds.push(manufacturerIdForFilter(manufacturer), manufacturer);
  }
  const category = params.get("category")?.trim();
  if (category) {
    const categoryId = categoryIdForFilter(category);
    if (categoryId) {
      where.push(
        "EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ?)",
      );
      binds.push(categoryId);
    } else {
      where.push("p.category = ?");
      binds.push(category);
    }
  }
  for (const feature of requestedFeatures(params)) {
    where.push(
      "EXISTS (SELECT 1 FROM product_feature_facts pff WHERE pff.product_id = p.id AND pff.feature_id = ? AND pff.state = 'present')",
    );
    binds.push(feature);
  }
  if (params.get("inStock") === "true") where.push("p.stock_status = 'in_stock'");
  if (params.get("newOnly") === "true")
    where.push(
      "COALESCE(p.source_published_at, p.first_seen_at) >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-48 hours')",
    );
  if (params.get("priceDropped") === "true")
    where.push(
      "(p.previous_price_yen IS NOT NULL AND p.price_yen IS NOT NULL AND p.price_yen < p.previous_price_yen)",
    );
  const minPrice = Number.parseInt(params.get("minPrice") || "", 10);
  if (Number.isFinite(minPrice)) {
    where.push("p.price_yen >= ?");
    binds.push(minPrice);
  }
  const maxPrice = Number.parseInt(params.get("maxPrice") || "", 10);
  if (Number.isFinite(maxPrice)) {
    where.push("p.price_yen <= ?");
    binds.push(maxPrice);
  }

  const countWhere = [...where];
  const countBinds = [...binds];
  const sort = sortDefinition(params.get("sort"));
  const cursor = decodeCursor(params.get("cursor"));
  addCursorPredicate(where, binds, sort, cursor);
  const requestedLimit = Number.parseInt(params.get("limit") || String(DEFAULT_PAGE_SIZE), 10);
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_PAGE_SIZE),
  );
  const requestedOffset = Number.parseInt(params.get("offset") || "0", 10);
  const offset = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0;
  const includeTotal = params.get("includeTotal") === "true";
  const orderBy = sort.price
    ? `p.price_yen ${sort.direction} NULLS LAST, p.id ${sort.idDirection}`
    : `p.${sort.column} ${sort.direction}, p.id ${sort.idDirection}`;

  let totalCount = null;
  if (includeTotal) {
    const countResult = await db
      .prepare(`SELECT COUNT(*) AS total FROM products p ${join} WHERE ${countWhere.join(" AND ")}`)
      .bind(...countBinds)
      .all<{ total: number }>();
    totalCount = Number(countResult.results?.[0]?.total || 0);
  }
  const paginationSql = offset > 0 ? "LIMIT ? OFFSET ?" : "LIMIT ?";
  const paginationBinds = offset > 0 ? [limit + 1, offset] : [limit + 1];
  const result = await db
    .prepare(
      `SELECT p.* FROM products p ${join} WHERE ${where.join(" AND ")} ORDER BY ${orderBy} ${paginationSql}`,
    )
    .bind(...binds, ...paginationBinds)
    .all<ProductRow>();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => productRow(row));
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? cursorFor(last, sort) : null,
    ...(includeTotal ? { totalCount, totalPages: Math.ceil((totalCount ?? 0) / limit) } : {}),
  };
}

export async function productHistory(
  db: QueryableDatabase,
  id: number,
): Promise<ProductHistoryResult | null> {
  const product = await db
    .prepare("SELECT * FROM products WHERE id = ?")
    .bind(id)
    .first<ProductRow>();
  if (!product) return null;
  const history = await db
    .prepare(
      "SELECT price_yen, observed_at FROM price_history WHERE product_id = ? ORDER BY observed_at ASC",
    )
    .bind(id)
    .all<PriceHistoryPoint>();
  return { product: productRow(product), history: history.results || [] };
}
