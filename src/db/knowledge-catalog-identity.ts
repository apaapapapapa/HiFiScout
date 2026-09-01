/**
 * The Catalog logical-identity rule at the database boundary.
 *
 * `src/catalog/knowledge-catalog-identity.ts` decides whether two Catalog rows name one product.
 * This module is how that rule reaches SQL: a bucket key that narrows a scan to the rows worth
 * comparing, the deterministic order that names the survivor of a set, and the lookup every writer
 * uses before it inserts a new Catalog row.
 *
 * Promotion, manual admin writes, the duplicates screen, and automatic convergence all go through
 * here, so none of them can decide "same product" differently from the others.
 */

import {
  catalogIdentityKey,
  catalogIdentityManufacturerIds,
} from "../catalog/knowledge-catalog-identity.js";
import type { KnowledgeCatalogLifecycleStatus, ReadableDatabase } from "./types.js";

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

/** How many Catalog rows one identity lookup compares before it gives up on a bucket. */
const IDENTITY_LOOKUP_SCAN_LIMIT = 50;

/**
 * SQL bucket key.
 *
 * A deliberate over-approximation of the identity rule: coarse enough that two rows naming one
 * product land in the same bucket, and every bucket is re-checked in TypeScript with the real
 * normalizer. A bucket that is too coarse therefore only costs a discarded row, never a wrong
 * group. The literals are module constants, never caller input.
 */
export function catalogIdentityBucketKeySql(column: string): string {
  let expression = `UPPER(${column})`;
  for (const separator of KEY_SEPARATORS) expression = `REPLACE(${expression}, '${separator}', '')`;
  for (const [spelling, canonical] of KEY_REVISION_MARKERS) {
    expression = `REPLACE(${expression}, '${spelling}', '${canonical}')`;
  }
  return expression;
}

/** The same folding as {@link catalogIdentityBucketKeySql}, for binding a lookup's bucket key. */
export function catalogIdentityBucketKey(value: unknown): string {
  let key = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toUpperCase();
  for (const separator of KEY_SEPARATORS) key = key.split(separator).join("");
  for (const [spelling, canonical] of KEY_REVISION_MARKERS)
    key = key.split(spelling).join(canonical);
  return key;
}

/** What the survivor of a duplicate set is chosen by. */
export interface CatalogIdentityRank {
  id: number;
  /** Active listings Product Identity currently attributes to the row. */
  matchedListingCount: number;
  /** First verification timestamp; the empty string sorts last. */
  firstVerifiedAt: string;
  /** A verified row always outranks a rejected one naming the same product. */
  verified?: boolean;
  /** A row already holding the caller's exact storage key outranks its identity siblings. */
  exactStorageKey?: boolean;
}

/**
 * The canonical order for one logical identity, most authoritative first.
 *
 * A row already holding the exact storage key comes first, then a verified row over a rejected one,
 * then the record carrying the most matched listings, then the one verified first, then the lowest
 * id. Keeping the busiest record moves the fewest identities and leaves the longest-standing entry
 * in place; the trailing id keeps the choice deterministic when nothing else separates two rows, so
 * repeating a convergence never picks a different survivor.
 */
export function canonicalCatalogIdentityOrder<T extends CatalogIdentityRank>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (left, right) =>
      Number(Boolean(right.exactStorageKey)) - Number(Boolean(left.exactStorageKey)) ||
      Number(right.verified !== false) - Number(left.verified !== false) ||
      right.matchedListingCount - left.matchedListingCount ||
      (left.firstVerifiedAt || "").localeCompare(right.firstVerifiedAt || "") ||
      left.id - right.id,
  );
}

/** A Catalog row as the identity lookup reports it. */
export interface CatalogIdentityProductRow {
  id: number;
  manufacturer_id: string;
  canonical_model: string;
  normalized_model: string;
  canonical_name: string;
  lifecycle_status: KnowledgeCatalogLifecycleStatus;
  verification_status: string;
  primary_category_id: string | null;
  first_verified_at: string | null;
  matched_listing_count: number | null;
}

const IDENTITY_COLUMNS = `
  kp.id, kp.manufacturer_id, kp.canonical_model, kp.normalized_model, kp.canonical_name,
  kp.lifecycle_status, kp.verification_status, kp.first_verified_at,
  (
    SELECT kpc.category_id
    FROM knowledge_catalog_product_categories kpc
    WHERE kpc.product_id = kp.id AND kpc.is_primary = 1
    LIMIT 1
  ) AS primary_category_id,
  (
    SELECT COUNT(*)
    FROM product_identity_resolutions pir
    JOIN products p ON p.id = pir.listing_product_id
    WHERE pir.catalog_product_id = kp.id AND pir.status = 'matched' AND p.is_active = 1
  ) AS matched_listing_count
`;

function rank(row: CatalogIdentityProductRow, normalizedModel: string): CatalogIdentityRank {
  return {
    id: Number(row.id),
    matchedListingCount: Number(row.matched_listing_count || 0),
    firstVerifiedAt: row.first_verified_at || "",
    verified: row.verification_status === "verified",
    exactStorageKey: row.normalized_model === normalizedModel,
  };
}

/**
 * Every Catalog row naming the same product as `(manufacturerId, normalizedModel)`, most
 * authoritative first.
 *
 * `normalizedModel` is the storage-normalized model, the value the unique index holds. Identity
 * normalization discards everything the two normalizers disagree about, so deriving the identity
 * from the storage spelling gives the same answer as deriving it from the raw one.
 *
 * The exact storage key is read first because it is the unique index and answers the common case
 * without a scan. Only when it does not already hold a verified row does the identity bucket get
 * scanned, so the extra read is paid on the promotions that can actually create a duplicate. The
 * bucket is an over-approximation, so every row it returns is re-checked with the real identity
 * rule before it counts as the same product.
 */
export async function findCatalogIdentityMatches(
  db: ReadableDatabase,
  manufacturerId: string,
  normalizedModel: string,
): Promise<CatalogIdentityProductRow[]> {
  const exact = await db
    .prepare(`
      SELECT ${IDENTITY_COLUMNS}
      FROM knowledge_catalog_products kp
      WHERE kp.manufacturer_id = ? AND kp.normalized_model = ?
      LIMIT 1
    `)
    .bind(manufacturerId, normalizedModel)
    .first<CatalogIdentityProductRow>();
  if (exact?.verification_status === "verified") return [exact];

  const identityKey = catalogIdentityKey(manufacturerId, normalizedModel);
  if (!identityKey) return exact ? [exact] : [];

  const scan = await db
    .prepare(`
      SELECT ${IDENTITY_COLUMNS}
      FROM knowledge_catalog_products kp
      WHERE kp.manufacturer_id IN (SELECT value FROM json_each(?))
        AND ${catalogIdentityBucketKeySql("kp.normalized_model")} = ?
      ORDER BY kp.id
      LIMIT ?
    `)
    .bind(
      JSON.stringify(catalogIdentityManufacturerIds(manufacturerId)),
      catalogIdentityBucketKey(normalizedModel),
      IDENTITY_LOOKUP_SCAN_LIMIT,
    )
    .all<CatalogIdentityProductRow>();

  const byId = new Map<number, CatalogIdentityProductRow>();
  if (exact) byId.set(Number(exact.id), exact);
  for (const row of scan.results || []) {
    if (catalogIdentityKey(row.manufacturer_id, row.canonical_model) !== identityKey) continue;
    byId.set(Number(row.id), row);
  }

  const ranked = [...byId.values()].map((row) => ({ ...rank(row, normalizedModel), row }));
  return canonicalCatalogIdentityOrder(ranked).map((entry) => entry.row);
}

/**
 * The Catalog row a writer must converge onto rather than inserting a second row for one product,
 * or `null` when the product is genuinely new.
 */
export async function findCatalogProductByIdentity(
  db: ReadableDatabase,
  manufacturerId: string,
  normalizedModel: string,
): Promise<CatalogIdentityProductRow | null> {
  const matches = await findCatalogIdentityMatches(db, manufacturerId, normalizedModel);
  return matches[0] || null;
}
