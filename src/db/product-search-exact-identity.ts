/**
 * Conservative grouping for listings that have a resolved manufacturer/model identity but have not
 * yet been promoted to a verified Knowledge Catalog product.
 *
 * Knowledge Catalog matches remain the strongest identity and continue to use `c-<id>` entities.
 * This module only removes the user-visible duplication window before that promotion: listings may
 * share an existing `l-<representative listing id>` fallback entity when their canonical
 * manufacturer id and resolved normalized model are exactly equal.
 *
 * Safety is deliberately asymmetric with fuzzy catalog discovery:
 *
 * - the model resolver must have produced `resolved`; candidates are never grouped;
 * - manufacturer id and normalized model must both be non-empty and match exactly;
 * - listings already matched to a verified catalog product are excluded;
 * - two different non-`other` categories veto the whole group;
 * - the representative is the lowest active unresolved listing id, making the key deterministic
 *   for the lifetime of that unresolved group without adding a third public entity kind.
 */

/** A confirmed Knowledge Catalog membership always wins over fallback exact-identity grouping. */
function hasVerifiedCatalogMatch(alias: string): string {
  return `EXISTS (
    SELECT 1
    FROM product_identity_resolutions r
    JOIN knowledge_catalog_products kp
      ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
    WHERE r.listing_product_id = ${alias}.id AND r.status = 'matched'
  )`;
}

/** Base predicate for a listing that may participate in an unresolved exact-identity group. */
function eligible(alias: string): string {
  return `${alias}.is_active = 1
    AND ${alias}.model_resolution_status = 'resolved'
    AND COALESCE(${alias}.canonical_manufacturer_id, '') <> ''
    AND COALESCE(${alias}.normalized_model, '') <> ''
    AND NOT ${hasVerifiedCatalogMatch(alias)}`;
}

function sameIdentity(left: string, right: string): string {
  return `${right}.canonical_manufacturer_id = ${left}.canonical_manufacturer_id
    AND ${right}.normalized_model = ${left}.normalized_model`;
}

/**
 * Exact text identity is not enough when the taxonomy says the rows are different product types.
 * `unclassified` and `other` are both ignored because they represent missing specificity, not
 * contradictory evidence: `unclassified` is the classifier's "no answer", and `other` was that
 * sentinel's id until the two were split, so listings still carry it for the same reason.
 */
function categoryCompatible(alias: string): string {
  return `(
    SELECT COUNT(DISTINCT CASE
      WHEN peer.primary_category_id NOT IN ('other', 'unclassified') THEN peer.primary_category_id
      ELSE NULL
    END)
    FROM products peer
    WHERE ${eligible("peer")}
      AND ${sameIdentity(alias, "peer")}
  ) <= 1`;
}

function representativeListingId(alias: string): string {
  return `(
    SELECT MIN(anchor.id)
    FROM products anchor
    WHERE ${eligible("anchor")}
      AND ${sameIdentity(alias, "anchor")}
  )`;
}

/**
 * Expands an incremental crawl/remediation scope to unresolved exact-identity peers.
 *
 * A newly observed listing can otherwise join the shared entity while an older shop's listing stays
 * stranded in its previous fallback entity until a full rebuild. The seed itself may already have
 * become a catalog match; unresolved peers still need to be revisited so their representative can
 * rotate or disappear during that transition.
 */
export function exactIdentityPeerIdsSql(seedCount: number): string {
  if (!seedCount) return "SELECT id FROM products WHERE 0";
  const placeholders = Array.from({ length: seedCount }, () => "?").join(",");
  return `
    SELECT DISTINCT peer.id AS id
    FROM products seed
    JOIN products peer
      ON ${sameIdentity("seed", "peer")}
    WHERE seed.id IN (${placeholders})
      AND seed.model_resolution_status = 'resolved'
      AND COALESCE(seed.canonical_manufacturer_id, '') <> ''
      AND COALESCE(seed.normalized_model, '') <> ''
      AND ${eligible("peer")}
      AND ${categoryCompatible("peer")}
  `;
}

/**
 * Reassigns safe unresolved listings from their per-listing fallback entity to one deterministic
 * representative fallback entity. Run after the ordinary fallback membership upsert: that keeps the
 * original conservative path intact and makes this rule an explicit, auditable refinement.
 */
export function upsertExactIdentityGroupOffersSql(listingScope = ""): string {
  return `
    INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
    SELECT p.id, e.id, p.shop_key
    FROM products p
    JOIN product_search_entities e
      ON e.entity_key = 'l-' || ${representativeListingId("p")}
    WHERE ${eligible("p")}
      AND ${categoryCompatible("p")}${listingScope}
    ON CONFLICT(listing_product_id) DO UPDATE SET
      entity_id = excluded.entity_id,
      shop_key = excluded.shop_key
  `;
}

/**
 * Production audit: every safe exact identity with multiple active listings must resolve to one
 * search entity. The count is zero after either an incremental peer sync or a full rebuild.
 */
export const EXACT_IDENTITY_SPLIT_COUNT_SQL = `
  SELECT COUNT(*) AS split_exact_identity_groups
  FROM (
    SELECT p.canonical_manufacturer_id, p.normalized_model
    FROM products p
    JOIN product_search_entity_offers m ON m.listing_product_id = p.id
    WHERE ${eligible("p")}
      AND ${categoryCompatible("p")}
    GROUP BY p.canonical_manufacturer_id, p.normalized_model
    HAVING COUNT(*) > 1 AND COUNT(DISTINCT m.entity_id) > 1
  ) split_groups
`;
