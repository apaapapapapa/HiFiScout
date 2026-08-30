import {
  UNCLASSIFIED_CATEGORY_ID,
  categoryClosureIds,
  categoryIdForClassification,
  categorySearchAliases,
  getCategory,
} from "../catalog/categories.js";
import { normalizeIdentityModel } from "../catalog/product-identity.js";
import type { ListingAdminListOptions, ListingAdminUpdateInput } from "../http/listing-admin.js";
import { refreshListingProjections } from "./listing-projection-refresh.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";

interface ListingAdminRow {
  id: number;
  shop_key: string;
  source_id: string;
  source_url: string;
  is_active: number;
  stock_status: string;
  price_yen: number | null;
  title: string;
  raw_manufacturer: string;
  manufacturer: string;
  manufacturer_id: string;
  canonical_manufacturer_id: string;
  manufacturer_resolution_status: string;
  manufacturer_resolution_method: string;
  manufacturer_resolution_confidence: string;
  manufacturer_resolver_version: number;
  raw_model: string;
  model: string;
  normalized_model: string;
  model_resolution_status: string;
  model_resolution_method: string;
  model_resolution_confidence: string;
  model_resolver_version: number;
  raw_category: string;
  category: string;
  primary_category_id: string;
  classification_status: string;
  presentation_color: string;
  last_seen_at: string;
  last_changed_at: string;
  last_activity_at: string;
  override_manufacturer_id: string | null;
  override_manufacturer_name: string | null;
  override_model: string | null;
  override_normalized_model: string | null;
  override_primary_category_id: string | null;
  override_category_ids: string | null;
  override_category_name: string | null;
  override_search_aliases: string | null;
  override_presentation_color: string | null;
  override_created_at: string | null;
  override_updated_at: string | null;
}

export interface ListingAdminProduct {
  id: number;
  shopKey: string;
  sourceId: string;
  sourceUrl: string;
  isActive: boolean;
  stockStatus: string;
  priceYen: number | null;
  title: string;
  rawManufacturer: string;
  manufacturer: string;
  manufacturerId: string;
  canonicalManufacturerId: string;
  rawModel: string;
  model: string;
  normalizedModel: string;
  rawCategory: string;
  category: string;
  primaryCategoryId: string;
  classificationStatus: string;
  presentationColor: string;
  lastSeenAt: string;
  lastChangedAt: string;
  lastActivityAt: string;
  overrides: {
    manufacturerId: string | null;
    model: string | null;
    primaryCategoryId: string | null;
    presentationColor: string | null;
    updatedAt: string | null;
  };
}

export interface ListingAdminListResult {
  items: ListingAdminProduct[];
  nextAfterId: number | null;
  hasMore: boolean;
}

export interface ListingAdminUpdateResult {
  listing: ListingAdminProduct;
  refreshedListings: number;
}

interface OverrideState {
  manufacturerId: string | null;
  manufacturerName: string | null;
  model: string | null;
  normalizedModel: string | null;
  primaryCategoryId: string | null;
  categoryIds: string[] | null;
  categoryName: string | null;
  searchAliases: string | null;
  presentationColor: string | null;
  createdAt: string | null;
}

interface VerifiedManufacturerRow {
  canonical_name: string;
}

const LISTING_SELECT = `
  SELECT p.id, p.shop_key, p.source_id, p.source_url, p.is_active, p.stock_status, p.price_yen,
         p.title, p.raw_manufacturer, p.manufacturer, p.manufacturer_id,
         p.canonical_manufacturer_id, p.manufacturer_resolution_status,
         p.manufacturer_resolution_method, p.manufacturer_resolution_confidence,
         p.manufacturer_resolver_version, p.raw_model, p.model, p.normalized_model,
         p.model_resolution_status, p.model_resolution_method, p.model_resolution_confidence,
         p.model_resolver_version, p.raw_category, p.category, p.primary_category_id,
         p.classification_status, p.presentation_color, p.last_seen_at, p.last_changed_at,
         p.last_activity_at,
         o.manufacturer_id AS override_manufacturer_id,
         o.manufacturer_name AS override_manufacturer_name,
         o.model AS override_model,
         o.normalized_model AS override_normalized_model,
         o.primary_category_id AS override_primary_category_id,
         o.category_ids AS override_category_ids,
         o.category_name AS override_category_name,
         o.search_aliases AS override_search_aliases,
         o.presentation_color AS override_presentation_color,
         o.created_at AS override_created_at,
         o.updated_at AS override_updated_at
  FROM products p
  LEFT JOIN product_admin_overrides o ON o.listing_product_id = p.id
`;

function parseJsonStrings(value: string | null): string[] | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function toProduct(row: ListingAdminRow): ListingAdminProduct {
  return {
    id: Number(row.id),
    shopKey: row.shop_key,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    isActive: Number(row.is_active) === 1,
    stockStatus: row.stock_status,
    priceYen: row.price_yen == null ? null : Number(row.price_yen),
    title: row.title,
    rawManufacturer: row.raw_manufacturer || "",
    manufacturer: row.manufacturer || "",
    manufacturerId: row.manufacturer_id || "",
    canonicalManufacturerId: row.canonical_manufacturer_id || "",
    rawModel: row.raw_model || "",
    model: row.model || "",
    normalizedModel: row.normalized_model || "",
    rawCategory: row.raw_category || "",
    category: row.category || "",
    primaryCategoryId: row.primary_category_id || "",
    classificationStatus: row.classification_status || "",
    presentationColor: row.presentation_color || "",
    lastSeenAt: row.last_seen_at || "",
    lastChangedAt: row.last_changed_at || "",
    lastActivityAt: row.last_activity_at || "",
    overrides: {
      manufacturerId: row.override_manufacturer_id,
      model: row.override_model,
      primaryCategoryId: row.override_primary_category_id,
      presentationColor: row.override_presentation_color,
      updatedAt: row.override_updated_at,
    },
  };
}

function overrideState(row: ListingAdminRow): OverrideState {
  return {
    manufacturerId: row.override_manufacturer_id,
    manufacturerName: row.override_manufacturer_name,
    model: row.override_model,
    normalizedModel: row.override_normalized_model,
    primaryCategoryId: row.override_primary_category_id,
    categoryIds: parseJsonStrings(row.override_category_ids),
    categoryName: row.override_category_name,
    searchAliases: row.override_search_aliases,
    presentationColor: row.override_presentation_color,
    createdAt: row.override_created_at,
  };
}

async function loadListing(
  db: ReadableDatabase,
  listingId: number,
): Promise<ListingAdminRow | null> {
  return db
    .prepare(`${LISTING_SELECT} WHERE p.id = ? LIMIT 1`)
    .bind(listingId)
    .first<ListingAdminRow>();
}

export async function listListingAdminProducts(
  db: ReadableDatabase,
  options: ListingAdminListOptions,
): Promise<ListingAdminListResult> {
  const where = ["p.id > ?"];
  const params: unknown[] = [options.afterId];

  if (options.activeOnly) where.push("p.is_active = 1");
  if (options.shopKey) {
    where.push("p.shop_key = ?");
    params.push(options.shopKey);
  }
  if (options.categoryId) {
    where.push(`EXISTS (
      SELECT 1 FROM product_categories pc
      WHERE pc.product_id = p.id AND pc.category_id = ?
    )`);
    params.push(options.categoryId);
  }
  if (options.query) {
    const pattern = `%${options.query.toLowerCase()}%`;
    where.push(`(
      LOWER(p.title) LIKE ? OR LOWER(p.source_id) LIKE ? OR LOWER(p.shop_key) LIKE ? OR
      LOWER(p.manufacturer) LIKE ? OR LOWER(p.raw_manufacturer) LIKE ? OR
      LOWER(p.manufacturer_id) LIKE ? OR LOWER(p.model) LIKE ? OR LOWER(p.raw_model) LIKE ? OR
      LOWER(p.presentation_color) LIKE ?
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }

  const result = await db
    .prepare(`${LISTING_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY p.id
      LIMIT ?
    `)
    .bind(...params, options.limit + 1)
    .all<ListingAdminRow>();
  const rows = result.results || [];
  const hasMore = rows.length > options.limit;
  const page = rows.slice(0, options.limit);
  const items = page.map(toProduct);
  return {
    items,
    hasMore,
    nextAfterId: hasMore && items.length ? items[items.length - 1].id : null,
  };
}

export function listingAdminCategoryIds(primaryCategoryValue: string): string[] {
  const primaryCategoryId = categoryIdForClassification(primaryCategoryValue);
  return primaryCategoryId ? categoryClosureIds(primaryCategoryId) : [];
}

async function verifiedManufacturerName(
  db: ReadableDatabase,
  manufacturerId: string,
): Promise<string> {
  if (!manufacturerId) return "";
  const row = await db
    .prepare(`
      SELECT canonical_name
      FROM knowledge_catalog_manufacturers
      WHERE id = ? AND verification_status = 'verified'
      LIMIT 1
    `)
    .bind(manufacturerId)
    .first<VerifiedManufacturerRow>();
  if (!row?.canonical_name) throw new Error("listing_admin_manufacturer_not_verified");
  return row.canonical_name;
}

function fieldChanged<T>(input: T | undefined, before: T): boolean {
  return input !== undefined && input !== before;
}

export async function updateListingAdminProduct(
  db: QueryableDatabase,
  listingId: number,
  input: ListingAdminUpdateInput,
  updatedAt = new Date().toISOString(),
): Promise<ListingAdminUpdateResult | null> {
  const existing = await loadListing(db, listingId);
  if (!existing) return null;

  const previousOverride = overrideState(existing);
  const merged: OverrideState = { ...previousOverride };

  if (input.manufacturerId !== undefined) {
    merged.manufacturerId = input.manufacturerId;
    merged.manufacturerName = await verifiedManufacturerName(db, input.manufacturerId);
  }
  if (input.model !== undefined) {
    merged.model = input.model;
    merged.normalizedModel = normalizeIdentityModel(input.model);
  }
  if (input.presentationColor !== undefined) {
    merged.presentationColor = input.presentationColor;
  }
  if (input.primaryCategoryId !== undefined) {
    const categoryIds = listingAdminCategoryIds(input.primaryCategoryId);
    const category = getCategory(input.primaryCategoryId);
    if (!category || !category.classifiable || categoryIds[0] !== category.id) {
      throw new Error("listing_admin_category_invalid");
    }
    merged.primaryCategoryId = category.id;
    merged.categoryIds = categoryIds;
    merged.categoryName = category.name;
    merged.searchAliases = categorySearchAliases(categoryIds);
  }

  const token = `listing-admin:${crypto.randomUUID()}`;
  const manufacturerOverridden = merged.manufacturerId !== null;
  const modelOverridden = merged.model !== null;
  const categoryOverridden = merged.primaryCategoryId !== null;
  const presentationColorOverridden = merged.presentationColor !== null;
  const manufacturerId = manufacturerOverridden
    ? merged.manufacturerId || ""
    : existing.manufacturer_id;
  const manufacturerName = manufacturerOverridden
    ? merged.manufacturerName || ""
    : existing.manufacturer;
  const model = modelOverridden ? merged.model || "" : existing.model;
  const normalizedModel = modelOverridden
    ? merged.normalizedModel || ""
    : existing.normalized_model;
  const categoryId = categoryOverridden
    ? merged.primaryCategoryId || UNCLASSIFIED_CATEGORY_ID
    : existing.primary_category_id;
  const categoryName = categoryOverridden ? merged.categoryName || "" : existing.category;
  const searchAliases = categoryOverridden
    ? merged.searchAliases || ""
    : categorySearchAliases([categoryId]);
  const presentationColor = presentationColorOverridden
    ? merged.presentationColor || ""
    : existing.presentation_color;

  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM product_admin_overrides WHERE listing_product_id = ?").bind(listingId),
    db
      .prepare(`
        UPDATE products
        SET manufacturer = ?, manufacturer_id = ?, canonical_manufacturer_id = ?,
            manufacturer_resolution_status = ?, manufacturer_resolution_method = ?,
            manufacturer_resolution_confidence = ?,
            model = ?, normalized_model = ?, model_resolution_status = ?,
            model_resolution_method = ?, model_resolution_confidence = ?,
            category = ?, primary_category_id = ?, category_ids = json_array(?),
            direct_category_ids = CASE WHEN ? THEN json_array(?) ELSE direct_category_ids END,
            classification_status = ?, search_aliases = ?, presentation_color = ?,
            remediation_projection_required = 1, remediation_projection_token = ?
        WHERE id = ?
      `)
      .bind(
        manufacturerName,
        manufacturerId,
        manufacturerId,
        manufacturerOverridden
          ? manufacturerId
            ? "resolved"
            : "unresolved"
          : existing.manufacturer_resolution_status,
        manufacturerOverridden
          ? manufacturerId
            ? "verified_alias"
            : "none"
          : existing.manufacturer_resolution_method,
        manufacturerOverridden
          ? manufacturerId
            ? "high"
            : "none"
          : existing.manufacturer_resolution_confidence,
        model,
        normalizedModel,
        modelOverridden ? (model ? "resolved" : "unresolved") : existing.model_resolution_status,
        modelOverridden
          ? model
            ? "seller_model_annotated"
            : "none"
          : existing.model_resolution_method,
        modelOverridden ? (model ? "high" : "none") : existing.model_resolution_confidence,
        categoryName,
        categoryId,
        categoryId,
        // Only a category override decides the direct set, and only that branch rebuilds
        // `product_categories` below. Rewriting it for an unrelated model or colour edit would
        // erase a set's categories and leave the two representations disagreeing.
        categoryOverridden ? 1 : 0,
        categoryId,
        categoryOverridden ? "classified" : existing.classification_status,
        searchAliases,
        presentationColor,
        token,
        listingId,
      ),
  ];

  if (categoryOverridden) {
    statements.push(
      db.prepare("DELETE FROM product_categories WHERE product_id = ?").bind(listingId),
    );
    for (const category of merged.categoryIds || []) {
      statements.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO product_categories(product_id, category_id, is_direct) VALUES (?, ?, ?)",
          )
          .bind(listingId, category, category === categoryId ? 1 : 0),
      );
    }
  }

  statements.push(
    db
      .prepare(`
        INSERT INTO product_admin_overrides(
          listing_product_id, manufacturer_id, manufacturer_name, model, normalized_model,
          primary_category_id, category_ids, category_name, search_aliases, presentation_color,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        listingId,
        merged.manufacturerId,
        merged.manufacturerName,
        merged.model,
        merged.normalizedModel,
        merged.primaryCategoryId,
        merged.categoryIds === null ? null : JSON.stringify(merged.categoryIds),
        merged.categoryName,
        merged.searchAliases,
        merged.presentationColor,
        merged.createdAt || updatedAt,
        updatedAt,
      ),
  );

  if (fieldChanged(input.manufacturerId, existing.canonical_manufacturer_id)) {
    statements.push(
      db
        .prepare(`
          INSERT INTO data_quality_remediation_events(
            listing_product_id, shop_key, source_id, field, previous_value, new_value, reason,
            resolver_method, resolver_confidence, resolver_version, processed_at
          ) VALUES (?, ?, ?, 'manufacturer', ?, ?, 'listing_admin_override', 'admin_override', 'high', ?, ?)
        `)
        .bind(
          listingId,
          existing.shop_key,
          existing.source_id,
          existing.canonical_manufacturer_id || "",
          manufacturerId,
          existing.manufacturer_resolver_version || 0,
          updatedAt,
        ),
    );
  }
  if (fieldChanged(input.model, existing.model)) {
    statements.push(
      db
        .prepare(`
          INSERT INTO data_quality_remediation_events(
            listing_product_id, shop_key, source_id, field, previous_value, new_value, reason,
            resolver_method, resolver_confidence, resolver_version, processed_at
          ) VALUES (?, ?, ?, 'model', ?, ?, 'listing_admin_override', 'admin_override', 'high', ?, ?)
        `)
        .bind(
          listingId,
          existing.shop_key,
          existing.source_id,
          existing.model || "",
          model,
          existing.model_resolver_version || 0,
          updatedAt,
        ),
    );
  }
  if (fieldChanged(input.primaryCategoryId, existing.primary_category_id)) {
    statements.push(
      db
        .prepare(`
          INSERT INTO data_quality_remediation_events(
            listing_product_id, shop_key, source_id, field, previous_value, new_value, reason,
            resolver_method, resolver_confidence, resolver_version, processed_at
          ) VALUES (?, ?, ?, 'category', ?, ?, 'listing_admin_override', 'admin_override', 'high', 0, ?)
        `)
        .bind(
          listingId,
          existing.shop_key,
          existing.source_id,
          existing.primary_category_id || "",
          categoryId,
          updatedAt,
        ),
    );
  }

  await db.batch(statements);
  await refreshListingProjections(
    db,
    [{ id: listingId, shop_key: existing.shop_key, source_id: existing.source_id }],
    updatedAt,
  );
  await db
    .prepare(`
      UPDATE products
      SET remediation_projection_required = 0, remediation_projection_token = ''
      WHERE id = ? AND remediation_projection_token = ?
    `)
    .bind(listingId, token)
    .run();

  const updated = await loadListing(db, listingId);
  if (!updated) throw new Error("listing_admin_product_disappeared_after_update");
  return { listing: toProduct(updated), refreshedListings: 1 };
}
