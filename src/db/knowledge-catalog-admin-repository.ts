import {
  categoryClosureIds,
  categoryIdForClassification,
  categorySearchAliases,
  getCategory,
} from "../catalog/categories.js";
import { manufacturerFilterIds } from "../catalog/manufacturers.js";
import { normalizeIdentityModel } from "../catalog/product-identity.js";
import { refreshListingProjections } from "./listing-projection-refresh.js";
import type {
  KnowledgeCatalogLifecycleStatus,
  QueryableDatabase,
  ReadableDatabase,
} from "./types.js";

const LISTING_PAGE_SIZE = 100;
const WRITE_BATCH_SIZE = 50;
const CATEGORY_PROJECTION_TOKEN_PREFIX = "category:admin:";

function normalizeCatalogAdminSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‐‑‒–—―－]/g, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function catalogAdminManufacturerIds(value: string): string[] {
  const raw = normalizeCatalogAdminSearchText(value);
  return [...new Set([raw, ...manufacturerFilterIds(value)])].filter(Boolean);
}

interface KnowledgeCatalogAdminListOptions {
  query: string;
  manufacturerId: string;
  categoryId: string;
  afterId: number;
  limit: number;
}

interface KnowledgeCatalogAdminUpdateInput {
  canonicalName: string;
  lifecycleStatus: KnowledgeCatalogLifecycleStatus;
  primaryCategoryId: string;
}

interface KnowledgeCatalogAdminProductRow {
  id: number;
  manufacturer_id: string;
  canonical_model: string;
  normalized_model: string;
  canonical_name: string;
  lifecycle_status: KnowledgeCatalogLifecycleStatus;
  verification_status: string;
  review_status: string;
  primary_category_id: string | null;
  category_ids: string | null;
  matched_listing_count: number | null;
  first_verified_at: string | null;
  last_verified_at: string | null;
  last_reviewed_at: string | null;
  updated_at: string;
}

interface MatchedCatalogListingRow {
  id: number;
  shop_key: string;
  source_id: string;
}

export interface KnowledgeCatalogAdminProduct {
  id: number;
  manufacturerId: string;
  canonicalModel: string;
  normalizedModel: string;
  canonicalName: string;
  lifecycleStatus: KnowledgeCatalogLifecycleStatus;
  verificationStatus: string;
  reviewStatus: string;
  primaryCategoryId: string;
  categoryIds: string[];
  matchedListingCount: number;
  firstVerifiedAt: string | null;
  lastVerifiedAt: string | null;
  lastReviewedAt: string | null;
  updatedAt: string;
}

export interface KnowledgeCatalogAdminListResult {
  items: KnowledgeCatalogAdminProduct[];
  nextAfterId: number | null;
  hasMore: boolean;
}

export interface KnowledgeCatalogAdminUpdateResult {
  product: KnowledgeCatalogAdminProduct;
  refreshedListings: number;
}

function parseCategoryIds(value: string | null): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toAdminProduct(row: KnowledgeCatalogAdminProductRow): KnowledgeCatalogAdminProduct {
  return {
    id: Number(row.id),
    manufacturerId: row.manufacturer_id,
    canonicalModel: row.canonical_model,
    normalizedModel: row.normalized_model,
    canonicalName: row.canonical_name,
    lifecycleStatus: row.lifecycle_status,
    verificationStatus: row.verification_status,
    reviewStatus: row.review_status,
    primaryCategoryId: row.primary_category_id || "",
    categoryIds: parseCategoryIds(row.category_ids),
    matchedListingCount: Number(row.matched_listing_count || 0),
    firstVerifiedAt: row.first_verified_at,
    lastVerifiedAt: row.last_verified_at,
    lastReviewedAt: row.last_reviewed_at,
    updatedAt: row.updated_at,
  };
}

const ADMIN_PRODUCT_SELECT = `
  SELECT kp.id, kp.manufacturer_id, kp.canonical_model, kp.normalized_model, kp.canonical_name,
         kp.lifecycle_status, kp.verification_status, kp.review_status,
         (
           SELECT kpc.category_id
           FROM knowledge_catalog_product_categories kpc
           WHERE kpc.product_id = kp.id AND kpc.is_primary = 1
           LIMIT 1
         ) AS primary_category_id,
         (
           SELECT GROUP_CONCAT(kpc.category_id)
           FROM knowledge_catalog_product_categories kpc
           WHERE kpc.product_id = kp.id
           ORDER BY kpc.is_primary DESC, kpc.category_id
         ) AS category_ids,
         (
           SELECT COUNT(*)
           FROM product_identity_resolutions pir
           JOIN products p ON p.id = pir.listing_product_id
           WHERE pir.catalog_product_id = kp.id AND pir.status = 'matched' AND p.is_active = 1
         ) AS matched_listing_count,
         kp.first_verified_at, kp.last_verified_at, kp.last_reviewed_at, kp.updated_at
  FROM knowledge_catalog_products kp
`;

async function loadAdminProduct(
  db: ReadableDatabase,
  productId: number,
): Promise<KnowledgeCatalogAdminProduct | null> {
  const row = await db
    .prepare(`${ADMIN_PRODUCT_SELECT}
      WHERE kp.id = ? AND kp.verification_status = 'verified'
      LIMIT 1
    `)
    .bind(productId)
    .first<KnowledgeCatalogAdminProductRow>();
  return row ? toAdminProduct(row) : null;
}

export async function listKnowledgeCatalogAdminProducts(
  db: ReadableDatabase,
  options: KnowledgeCatalogAdminListOptions,
): Promise<KnowledgeCatalogAdminListResult> {
  const where = ["kp.verification_status = 'verified'", "kp.id > ?"];
  const params: unknown[] = [options.afterId];

  if (options.query) {
    const textQuery = normalizeCatalogAdminSearchText(options.query);
    const identityQuery = normalizeIdentityModel(options.query).toLowerCase();
    const manufacturerIds = catalogAdminManufacturerIds(options.query);
    where.push(`(
      INSTR(LOWER(kp.canonical_name), ?) > 0 OR
      INSTR(LOWER(kp.canonical_model), ?) > 0 OR
      INSTR(LOWER(kp.manufacturer_id), ?) > 0 OR
      kp.manufacturer_id IN (SELECT value FROM json_each(?)) OR
      (? <> '' AND INSTR(LOWER(kp.normalized_model), ?) > 0) OR
      EXISTS (
        SELECT 1
        FROM knowledge_catalog_aliases search_alias
        WHERE search_alias.product_id = kp.id
          AND (
            INSTR(LOWER(search_alias.alias), ?) > 0 OR
            (? <> '' AND INSTR(LOWER(search_alias.normalized_alias), ?) > 0)
          )
      )
    )`);
    params.push(
      textQuery,
      textQuery,
      textQuery,
      JSON.stringify(manufacturerIds),
      identityQuery,
      identityQuery,
      textQuery,
      identityQuery,
      identityQuery,
    );
  }
  if (options.manufacturerId) {
    where.push("kp.manufacturer_id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(catalogAdminManufacturerIds(options.manufacturerId)));
  }
  if (options.categoryId) {
    where.push(`EXISTS (
      SELECT 1
      FROM knowledge_catalog_product_categories category_filter
      WHERE category_filter.product_id = kp.id AND category_filter.category_id = ?
    )`);
    params.push(options.categoryId);
  }

  const result = await db
    .prepare(`${ADMIN_PRODUCT_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY kp.id
      LIMIT ?
    `)
    .bind(...params, options.limit + 1)
    .all<KnowledgeCatalogAdminProductRow>();
  const rows = result.results || [];
  const hasMore = rows.length > options.limit;
  const page = rows.slice(0, options.limit);
  const items = page.map(toAdminProduct);
  return {
    items,
    hasMore,
    nextAfterId: hasMore && items.length ? items[items.length - 1].id : null,
  };
}

export function catalogAdminCategoryIds(primaryCategoryValue: string): string[] {
  const primaryCategoryId = categoryIdForClassification(primaryCategoryValue);
  return primaryCategoryId ? categoryClosureIds(primaryCategoryId) : [];
}

async function runBatches(db: QueryableDatabase, statements: D1PreparedStatement[]): Promise<void> {
  for (let index = 0; index < statements.length; index += WRITE_BATCH_SIZE) {
    await db.batch(statements.slice(index, index + WRITE_BATCH_SIZE));
  }
}

export async function propagateCatalogCategoryToMatchedListings(
  db: QueryableDatabase,
  catalogProductId: number,
  categoryIds: readonly string[],
  updatedAt: string,
  listingIds?: readonly number[],
): Promise<number> {
  if (listingIds && (!listingIds.length || listingIds.length > 10)) {
    if (!listingIds.length) return 0;
    throw new Error("csv_replay_page_too_large");
  }
  const primary = getCategory(categoryIds[0] || "");
  if (!primary?.classifiable) throw new Error("catalog_admin_primary_category_invalid");

  let afterId = 0;
  let refreshedListings = 0;
  for (;;) {
    const result = await db
      .prepare(`
        SELECT p.id, p.shop_key, p.source_id
        FROM products p
        JOIN product_identity_resolutions pir ON pir.listing_product_id = p.id
        WHERE ${listingIds ? "1 = 1" : "p.is_active = 1"}
          AND pir.status = 'matched' AND pir.catalog_product_id = ? AND p.id > ?
          ${listingIds ? "AND p.id IN (" + listingIds.map(() => "?").join(",") + ")" : ""}
        ORDER BY p.id
        LIMIT ?
      `)
      .bind(catalogProductId, afterId, ...(listingIds || []), LISTING_PAGE_SIZE)
      .all<MatchedCatalogListingRow>();
    const listings = result.results || [];
    if (!listings.length) break;

    const tokens = new Map<number, string>();
    const statements: D1PreparedStatement[] = [];
    for (const listing of listings) {
      const token = `${CATEGORY_PROJECTION_TOKEN_PREFIX}${crypto.randomUUID()}`;
      tokens.set(Number(listing.id), token);
      statements.push(
        db
          .prepare(`
            UPDATE products
            SET category = ?, primary_category_id = ?, category_ids = ?, classification_status = 'classified',
                direct_category_ids = ?,
                search_aliases = ?, remediation_projection_required = 1, remediation_projection_token = ?
            WHERE id = ?
          `)
          .bind(
            primary.name,
            primary.id,
            JSON.stringify(categoryIds),
            // An admin decided one category for this listing, so that is its one direct category.
            JSON.stringify([primary.id]),
            categorySearchAliases(categoryIds),
            token,
            listing.id,
          ),
      );
      statements.push(
        db.prepare("DELETE FROM product_categories WHERE product_id = ?").bind(listing.id),
      );
      for (const categoryId of categoryIds) {
        statements.push(
          db
            .prepare(
              "INSERT OR IGNORE INTO product_categories(product_id, category_id, is_direct) VALUES (?, ?, ?)",
            )
            .bind(listing.id, categoryId, categoryId === primary.id ? 1 : 0),
        );
      }
    }
    await runBatches(db, statements);

    // This dependency-ordered refresh updates search projection, identity resolution, and product
    // search entities. If it fails, the category:* token remains durable retry work for the normal
    // Knowledge Catalog finalizer instead of pretending propagation completed.
    await refreshListingProjections(db, listings, updatedAt);

    await runBatches(
      db,
      listings.map((listing) =>
        db
          .prepare(`
            UPDATE products
            SET remediation_projection_required = 0, remediation_projection_token = ''
            WHERE id = ? AND remediation_projection_token = ?
          `)
          .bind(listing.id, tokens.get(Number(listing.id)) || ""),
      ),
    );

    refreshedListings += listings.length;
    afterId = Number(listings[listings.length - 1].id);
    if (listings.length < LISTING_PAGE_SIZE) break;
  }
  return refreshedListings;
}

export async function updateKnowledgeCatalogAdminProduct(
  db: QueryableDatabase,
  productId: number,
  input: KnowledgeCatalogAdminUpdateInput,
  updatedAt = new Date().toISOString(),
): Promise<KnowledgeCatalogAdminUpdateResult | null> {
  const existing = await loadAdminProduct(db, productId);
  if (!existing) return null;

  const categoryIds = catalogAdminCategoryIds(input.primaryCategoryId);
  if (!categoryIds.length || categoryIds[0] !== input.primaryCategoryId) {
    throw new Error("catalog_admin_category_invalid");
  }

  const statements: D1PreparedStatement[] = [
    db
      .prepare(`
        UPDATE knowledge_catalog_products
        SET canonical_name = ?, lifecycle_status = ?, review_status = 'current',
            last_verified_at = ?, last_reviewed_at = ?, remediation_after_listing_id = 0,
            updated_at = ?
        WHERE id = ? AND verification_status = 'verified'
      `)
      .bind(input.canonicalName, input.lifecycleStatus, updatedAt, updatedAt, updatedAt, productId),
    db
      .prepare("DELETE FROM knowledge_catalog_product_categories WHERE product_id = ?")
      .bind(productId),
  ];

  for (const categoryId of categoryIds) {
    statements.push(
      db
        .prepare(`
          INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
          VALUES (?, ?, ?)
        `)
        .bind(productId, categoryId, categoryId === input.primaryCategoryId ? 1 : 0),
    );
  }
  statements.push(
    db
      .prepare(`
        INSERT INTO knowledge_catalog_sources (
          product_id, source_type, source_url, retrieved_at, content_hash, status, created_at, updated_at
        ) VALUES (?, 'manual_verified', '', ?, '', 'active', ?, ?)
        ON CONFLICT(product_id, source_type, source_url) DO UPDATE SET
          retrieved_at = excluded.retrieved_at,
          status = 'active',
          updated_at = excluded.updated_at
      `)
      .bind(productId, updatedAt, updatedAt, updatedAt),
  );
  await runBatches(db, statements);

  const refreshedListings = await propagateCatalogCategoryToMatchedListings(
    db,
    productId,
    categoryIds,
    updatedAt,
  );
  const product = await loadAdminProduct(db, productId);
  if (!product) throw new Error("catalog_admin_product_disappeared_after_update");
  return { product, refreshedListings };
}
