import { manufacturerFilterIds, manufacturerIdForFilter } from "../catalog/manufacturers.js";
import { normalizeIdentityModel } from "../catalog/product-identity.js";
import type { KnowledgeCatalogDuplicateListOptions } from "../http/knowledge-catalog-admin.js";
import type { KnowledgeCatalogLifecycleStatus, ReadableDatabase } from "./types.js";

/**
 * How many bucket keys one scan reads before the page is cut. Buckets are grouped in SQL by an
 * approximate key, so some of them turn out to hold unrelated manufacturers; scanning several
 * times the requested group count keeps a page from coming back empty while duplicates remain.
 */
const KEY_SCAN_FACTOR = 4;
const MAX_SCANNED_KEYS = 400;

/**
 * Separators the catalog model normalizer keeps but the identity normalizer drops. They are the
 * reason `PMA-2500NE` and `PMA2500NE` can both hold a row under
 * `UNIQUE(manufacturer_id, normalized_model)` while naming one product.
 */
const KEY_SEPARATORS: readonly string[] = [" ", "-", "_", ".", "/"];

/**
 * Revision spellings folded by literal replacement, longest first so `MKIII` is not consumed as
 * `MKII` followed by a stray `I`.
 */
const KEY_REVISION_MARKERS: readonly (readonly [string, string])[] = [
  ["MARKIII", "MK3"],
  ["MARKIV", "MK4"],
  ["MARKII", "MK2"],
  ["MARKI", "MK1"],
  ["MKIII", "MK3"],
  ["MKIV", "MK4"],
  ["MKII", "MK2"],
  ["MKI", "MK1"],
];

/**
 * SQL bucket key.
 *
 * A deliberate over-approximation of {@link normalizeIdentityModel}: coarse enough that two rows
 * naming one product land in the same bucket, and every bucket is re-checked in TypeScript with
 * the real normalizer. A bucket that is too coarse therefore only costs a discarded row, never a
 * wrong group. The literals are module constants, never caller input.
 */
export function duplicateBucketKeySql(column: string): string {
  let expression = `UPPER(${column})`;
  for (const separator of KEY_SEPARATORS) expression = `REPLACE(${expression}, '${separator}', '')`;
  for (const [spelling, canonical] of KEY_REVISION_MARKERS) {
    expression = `REPLACE(${expression}, '${spelling}', '${canonical}')`;
  }
  return expression;
}

export interface KnowledgeCatalogDuplicateProduct {
  id: number;
  manufacturerId: string;
  canonicalModel: string;
  canonicalName: string;
  lifecycleStatus: KnowledgeCatalogLifecycleStatus;
  primaryCategoryId: string;
  matchedListingCount: number;
  aliasCount: number;
  sourceCount: number;
  updatedAt: string;
}

export interface KnowledgeCatalogDuplicateGroup {
  /** Stable identifier for one duplicate set, safe to use as a list key. */
  groupKey: string;
  /** Canonical manufacturer id every member resolves to. */
  manufacturerId: string;
  /** Identity model every member resolves to. */
  identityModel: string;
  /** The member the admin is offered as the surviving Catalog. */
  suggestedTargetId: number;
  products: KnowledgeCatalogDuplicateProduct[];
}

export interface KnowledgeCatalogDuplicateListResult {
  items: KnowledgeCatalogDuplicateGroup[];
  nextAfterKey: string | null;
  hasMore: boolean;
}

interface DuplicateRow {
  id: number;
  manufacturer_id: string;
  canonical_model: string;
  canonical_name: string;
  lifecycle_status: KnowledgeCatalogLifecycleStatus;
  primary_category_id: string | null;
  matched_listing_count: number | null;
  alias_count: number | null;
  source_count: number | null;
  first_verified_at: string | null;
  updated_at: string;
  bucket_key: string;
}

interface RefinedGroup {
  manufacturerId: string;
  identityModel: string;
  products: DuplicateRow[];
}

function toDuplicateProduct(row: DuplicateRow): KnowledgeCatalogDuplicateProduct {
  return {
    id: Number(row.id),
    manufacturerId: row.manufacturer_id,
    canonicalModel: row.canonical_model,
    canonicalName: row.canonical_name,
    lifecycleStatus: row.lifecycle_status,
    primaryCategoryId: row.primary_category_id || "",
    matchedListingCount: Number(row.matched_listing_count || 0),
    aliasCount: Number(row.alias_count || 0),
    sourceCount: Number(row.source_count || 0),
    updatedAt: row.updated_at,
  };
}

/**
 * The Catalog a merge should keep: the record carrying the most matched listings, then the one
 * verified first, then the lowest id. Keeping the busiest record moves the fewest identities and
 * leaves the longest-standing entry in place.
 */
function suggestedTarget(
  rows: readonly DuplicateRow[],
  matchedListings: Map<number, number>,
): number {
  return [...rows].sort(
    (left, right) =>
      (matchedListings.get(Number(right.id)) || 0) - (matchedListings.get(Number(left.id)) || 0) ||
      (left.first_verified_at || "").localeCompare(right.first_verified_at || "") ||
      Number(left.id) - Number(right.id),
  )[0].id;
}

/**
 * Splits one SQL bucket into the groups that are genuinely the same product.
 *
 * Members are re-keyed with the identity normalizer and the manufacturer resolver, which is what
 * product identity resolution matches on, so a bucket holding two manufacturers or two real models
 * falls apart here instead of being offered as a merge.
 */
function refineBucket(rows: readonly DuplicateRow[]): RefinedGroup[] {
  const groups = new Map<string, RefinedGroup>();
  for (const row of rows) {
    const identityModel = normalizeIdentityModel(row.canonical_model);
    // A model that normalizes away entirely carries no identity to compare, so it can never be
    // reported as a duplicate of anything.
    if (!identityModel) continue;
    const manufacturerId = manufacturerIdForFilter(row.manufacturer_id) || row.manufacturer_id;
    const key = `${manufacturerId} ${identityModel}`;
    const group = groups.get(key);
    if (group) group.products.push(row);
    else groups.set(key, { manufacturerId, identityModel, products: [row] });
  }
  return [...groups.values()].filter((group) => group.products.length > 1);
}

function duplicateManufacturerIds(value: string): string[] {
  const raw = value.normalize("NFKC").trim().toLowerCase();
  return [...new Set([raw, ...manufacturerFilterIds(value)])].filter(Boolean);
}

/**
 * Verified Catalog records that name one product more than once.
 *
 * `UNIQUE(manufacturer_id, normalized_model)` only rules out byte-identical identities, so the same
 * product still splits across rows when a seller spelling reaches manual verification with
 * different separators (`PMA-2500NE` / `PMA2500NE`), a different revision spelling (`MK II` /
 * `MKII`), or a manufacturer id from before the resolver learned its canonical form.
 *
 * Paging walks bucket keys rather than rows, so every member of a duplicate set arrives on one
 * page and the caller can merge it without a second lookup.
 */
export async function listKnowledgeCatalogDuplicates(
  db: ReadableDatabase,
  options: KnowledgeCatalogDuplicateListOptions,
): Promise<KnowledgeCatalogDuplicateListResult> {
  const bucketKey = duplicateBucketKeySql("kp.normalized_model");
  const scannedKeys = Math.min(options.limit * KEY_SCAN_FACTOR, MAX_SCANNED_KEYS);
  const where = ["kp.verification_status = 'verified'"];
  const params: unknown[] = [];
  if (options.manufacturerId) {
    // Expanding to every id the resolver treats as the same manufacturer keeps the legacy-id
    // duplicates -- the ones this screen exists for -- inside the filtered scan.
    where.push("kp.manufacturer_id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(duplicateManufacturerIds(options.manufacturerId)));
  }

  const result = await db
    .prepare(`
      WITH bucketed AS (
        SELECT kp.id, kp.manufacturer_id, kp.canonical_model, kp.normalized_model,
               kp.canonical_name, kp.lifecycle_status, kp.first_verified_at, kp.updated_at,
               ${bucketKey} AS bucket_key,
               COUNT(*) OVER (PARTITION BY ${bucketKey}) AS bucket_size
        FROM knowledge_catalog_products kp
        WHERE ${where.join(" AND ")}
      ),
      page AS (
        SELECT DISTINCT bucket_key
        FROM bucketed
        WHERE bucket_size > 1 AND bucket_key <> '' AND bucket_key > ?
        ORDER BY bucket_key
        LIMIT ?
      )
      SELECT b.id, b.manufacturer_id, b.canonical_model, b.canonical_name,
             b.lifecycle_status, b.first_verified_at, b.updated_at, b.bucket_key,
             (
               SELECT kpc.category_id
               FROM knowledge_catalog_product_categories kpc
               WHERE kpc.product_id = b.id AND kpc.is_primary = 1
               LIMIT 1
             ) AS primary_category_id,
             (
               SELECT COUNT(*)
               FROM product_identity_resolutions pir
               JOIN products p ON p.id = pir.listing_product_id
               WHERE pir.catalog_product_id = b.id AND pir.status = 'matched' AND p.is_active = 1
             ) AS matched_listing_count,
             (
               SELECT COUNT(*)
               FROM knowledge_catalog_aliases ka
               WHERE ka.product_id = b.id
             ) AS alias_count,
             (
               SELECT COUNT(*)
               FROM knowledge_catalog_sources ks
               WHERE ks.product_id = b.id
             ) AS source_count
      FROM bucketed b
      JOIN page ON page.bucket_key = b.bucket_key
      ORDER BY b.bucket_key, b.id
    `)
    .bind(...params, options.afterKey, scannedKeys)
    .all<DuplicateRow>();

  const rows = result.results || [];
  const buckets: { key: string; rows: DuplicateRow[] }[] = [];
  for (const row of rows) {
    const current = buckets.at(-1);
    if (current && current.key === row.bucket_key) current.rows.push(row);
    else buckets.push({ key: row.bucket_key, rows: [row] });
  }
  const scanExhausted = buckets.length < scannedKeys;

  const items: KnowledgeCatalogDuplicateGroup[] = [];
  let lastIncludedKey = "";
  let cutShort = false;
  for (const bucket of buckets) {
    const groups = refineBucket(bucket.rows);
    // A bucket is never split across pages: the cursor is a bucket key, so half a bucket could
    // not be resumed.
    if (items.length && items.length + groups.length > options.limit) {
      cutShort = true;
      break;
    }
    for (const group of groups) {
      const products = group.products.map(toDuplicateProduct);
      const matchedListings = new Map(
        products.map((product) => [product.id, product.matchedListingCount]),
      );
      items.push({
        groupKey: `${group.manufacturerId}:${group.identityModel}`,
        manufacturerId: group.manufacturerId,
        identityModel: group.identityModel,
        suggestedTargetId: Number(suggestedTarget(group.products, matchedListings)),
        products,
      });
    }
    lastIncludedKey = bucket.key;
  }

  const hasMore = cutShort || !scanExhausted;
  return { items, nextAfterKey: hasMore ? lastIncludedKey : null, hasMore };
}
