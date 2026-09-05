/**
 * The set-wise SQL that maintains the product-level search read model.
 *
 * Every statement is written once and reused by three callers with different scopes: the crawler's
 * incremental sync (scoped to the listings a shop just reported), the deterministic rebuild (no
 * scope at all) and the migration backfill, which copies the unscoped text. Keeping one definition
 * is what stops the incremental path and the repair path from disagreeing about what an entity is.
 *
 * The invariants these statements encode:
 *
 * - a listing joins a canonical entity only through a `matched` identity resolution that points at
 *   a verified Knowledge Catalog product; nothing else may merge two shops' listings;
 * - other active listings use `unresolved_listing` fallback entities; safe resolved exact
 *   manufacturer/model peers share the lowest eligible representative, without guessing matches;
 * - membership exists only for active listings, and `listing_product_id` is the membership primary
 *   key, so a listing can belong to exactly one entity;
 * - an entity with no active offers is deleted rather than shown with nothing to buy.
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
export function eligibleExactIdentitySql(alias: string): string {
  return `${alias}.is_active = 1
    AND ${alias}.model_resolution_status = 'resolved'
    AND COALESCE(${alias}.canonical_manufacturer_id, '') <> ''
    AND COALESCE(${alias}.normalized_model, '') <> ''
    AND NOT ${hasVerifiedCatalogMatch(alias)}`;
}

export function sameExactIdentitySql(left: string, right: string): string {
  return `${right}.canonical_manufacturer_id = ${left}.canonical_manufacturer_id
    AND ${right}.normalized_model = ${left}.normalized_model`;
}

/**
 * Exact text identity is not enough when the taxonomy says the rows are different product types.
 * `unclassified` and `other` are both ignored because they represent missing specificity, not
 * contradictory evidence: `unclassified` is the classifier's "no answer", and `other` was that
 * sentinel's id until the two were split, so listings still carry it for the same reason.
 */
export function compatibleExactIdentityCategoriesSql(alias: string): string {
  return `(
    SELECT COUNT(DISTINCT CASE
      WHEN peer.primary_category_id NOT IN ('other', 'unclassified') THEN peer.primary_category_id
      ELSE NULL
    END
    )
    FROM products peer
    WHERE ${eligibleExactIdentitySql("peer")}
      AND ${sameExactIdentitySql(alias, "peer")}
  ) <= 1`;
}

export function exactIdentityRepresentativeListingIdSql(alias: string): string {
  return `(
    SELECT MIN(anchor.id)
    FROM products anchor
    WHERE ${eligibleExactIdentitySql("anchor")}
      AND ${sameExactIdentitySql(alias, "anchor")}
  )`;
}

/**
 * Final fallback owner, shared by entity creation and offer assignment.
 * Keep whitespace after END for Wrangler's SQL-file statement splitter as well as SQLite.
 */
export function fallbackRepresentativeListingIdSql(alias: string): string {
  return `CASE WHEN ${eligibleExactIdentitySql(alias)} AND ${compatibleExactIdentityCategoriesSql(alias)}
    THEN ${exactIdentityRepresentativeListingIdSql(alias)} ELSE ${alias}.id END
  `;
}

/**
 * How long a listing counts as "new".
 *
 * The same window the listing search has always used. It is expressed twice — as SQL for the
 * `newOnly` filter and as milliseconds for the badge the card renders — so both spellings are
 * derived from this one number rather than drifting apart as two literals.
 */
export const NEW_OFFER_WINDOW_HOURS = 48;

export const NEW_OFFER_WINDOW_MS = NEW_OFFER_WINDOW_HOURS * 60 * 60 * 1000;

/** Whether a listing row is newly published/first seen, as a SQL predicate over `products`. */
export function newOfferPredicate(alias: string): string {
  return `COALESCE(${alias}.source_published_at, ${alias}.first_seen_at) >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${NEW_OFFER_WINDOW_HOURS} hours')`;
}

/** `IN (?, ?, ...)` scope fragment, or `""` for the whole table. */
export function scopeClause(column: string, count: number): string {
  if (!count) return "";
  return ` AND ${column} IN (${Array.from({ length: count }, () => "?").join(",")})`;
}

const ENTITY_COLUMNS = [
  "entity_key",
  "entity_kind",
  "catalog_product_id",
  "fallback_listing_id",
  "manufacturer_id",
  "manufacturer",
  "model",
  "normalized_model",
  "primary_category_id",
  "manufacturer_terms",
  "model_terms",
  "title_terms",
  "category_terms",
] as const;

/** Filter before INSERT: an ON CONFLICT no-op still writes sqlite_sequence for AUTOINCREMENT. */
function entityUpsertSql(projection: string, changedColumns: readonly string[]): string {
  const differs = changedColumns
    .map((column) => `existing.${column} IS NOT desired.${column}`)
    .join(" OR ");
  return `
    INSERT INTO product_search_entities(${ENTITY_COLUMNS.join(", ")})
    SELECT desired.* FROM (${projection}) AS desired
    LEFT JOIN product_search_entities existing ON existing.entity_key = desired.entity_key
    WHERE existing.id IS NULL OR ${differs}
    ON CONFLICT(entity_key) DO UPDATE SET
      ${changedColumns.map((column) => `${column} = excluded.${column}`).join(", ")}
  `;
}

/**
 * Canonical entities for listings whose identity is confirmed.
 *
 * Canonical facts come from the Knowledge Catalog, never from a seller listing: the listing only
 * decides *whether* the entity is currently needed. Display manufacturer and the seller-evidence
 * search terms are filled in by the refresh statements below.
 *
 * A verified product with no category row falls back to the `unclassified` sentinel rather than
 * the `other` leaf: `other` is a real category a product can belong to (tuner, equalizer,
 * channel divider), so borrowing it here made "no category recorded" indistinguishable from it.
 */
export function upsertCatalogEntitiesSql(listingScope = ""): string {
  return entityUpsertSql(
    `
    SELECT 'c-' || kp.id AS entity_key, 'catalog' AS entity_kind, kp.id AS catalog_product_id, NULL AS fallback_listing_id,
           kp.manufacturer_id AS manufacturer_id,
           '' AS manufacturer,
           kp.canonical_model AS model,
           kp.normalized_model AS normalized_model,
           COALESCE((
             SELECT kpc.category_id FROM knowledge_catalog_product_categories kpc
             WHERE kpc.product_id = kp.id
             ORDER BY kpc.is_primary DESC, kpc.category_id
             LIMIT 1
           ), 'unclassified') AS primary_category_id,
           TRIM(kp.manufacturer_id) AS manufacturer_terms,
           TRIM(
             kp.canonical_model || ' ' || kp.normalized_model || ' ' ||
             COALESCE((
               SELECT group_concat(a.alias, ' ') FROM knowledge_catalog_aliases a
               WHERE a.product_id = kp.id AND a.alias_type = 'model'
             ), '')
           ) AS model_terms,
           '' AS title_terms,
           '' AS category_terms
    FROM knowledge_catalog_products kp
    WHERE kp.verification_status = 'verified'
      AND EXISTS (
        SELECT 1 FROM product_identity_resolutions r
        JOIN products p ON p.id = r.listing_product_id
        WHERE r.catalog_product_id = kp.id AND r.status = 'matched' AND p.is_active = 1${listingScope}
      )
  `,
    [
      "manufacturer_id",
      "model",
      "normalized_model",
      "primary_category_id",
      "manufacturer_terms",
      "model_terms",
    ],
  );
}

/**
 * Standalone entities for listings the identity layer has not confirmed.
 *
 * Candidates, fuzzy suggestions and vetoed matches all land here: anything short of `matched`
 * against a verified catalog product stays a shop-local product rather than being merged.
 */
export function upsertFallbackEntitiesSql(listingScope = ""): string {
  return entityUpsertSql(
    `
    SELECT 'l-' || p.id AS entity_key, 'unresolved_listing' AS entity_kind, NULL AS catalog_product_id, p.id AS fallback_listing_id,
           COALESCE(NULLIF(sp.manufacturer_id, ''), p.manufacturer_id) AS manufacturer_id,
           p.manufacturer AS manufacturer,
           p.model AS model,
           COALESCE(sp.normalized_model, '') AS normalized_model,
           p.primary_category_id AS primary_category_id,
           COALESCE(NULLIF(sp.manufacturer_terms, ''), p.manufacturer) AS manufacturer_terms,
           COALESCE(NULLIF(sp.model_terms, ''), p.model) AS model_terms,
           '' AS title_terms,
           '' AS category_terms
    FROM products p
    LEFT JOIN product_search_projection sp ON sp.product_id = p.id
    WHERE p.is_active = 1
      AND NOT EXISTS (
        SELECT 1 FROM product_identity_resolutions r
        JOIN knowledge_catalog_products kp
          ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
        WHERE r.listing_product_id = p.id AND r.status = 'matched'
      )${listingScope}
      AND p.id = ${fallbackRepresentativeListingIdSql("p")}
  `,
    [
      "manufacturer_id",
      "manufacturer",
      "model",
      "normalized_model",
      "primary_category_id",
      "manufacturer_terms",
      "model_terms",
    ],
  );
}

/** A deactivated listing stops being an offer immediately; its entity is re-aggregated after. */
export function deleteInactiveOffersSql(listingScope = ""): string {
  return `
    DELETE FROM product_search_entity_offers
    WHERE listing_product_id IN (
      SELECT m.listing_product_id
      FROM product_search_entity_offers m
      JOIN products p ON p.id = m.listing_product_id
      WHERE p.is_active = 0${listingScope}
    )
  `;
}

export function upsertCatalogOffersSql(listingScope = ""): string {
  return `
    INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
    SELECT p.id, e.id, p.shop_key
    FROM products p
    JOIN product_identity_resolutions r ON r.listing_product_id = p.id AND r.status = 'matched'
    JOIN knowledge_catalog_products kp
      ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
    JOIN product_search_entities e ON e.entity_key = 'c-' || kp.id
    WHERE p.is_active = 1${listingScope}
    ON CONFLICT(listing_product_id) DO UPDATE SET
      entity_id = excluded.entity_id,
      shop_key = excluded.shop_key
    WHERE product_search_entity_offers.entity_id IS NOT excluded.entity_id
       OR product_search_entity_offers.shop_key IS NOT excluded.shop_key
  `;
}

/**
 * Fallback membership, with the identity predicate repeated rather than assumed.
 *
 * The obvious shortcut — "a fallback entity only exists for an unmatched listing, so joining on the
 * key is enough" — is wrong during the transition that matters most. When a listing is confirmed,
 * its fallback entity still exists until the prune at the end of the pass, so a membership upsert
 * without this check would find `l-<id>` and pull the listing straight back out of the canonical
 * product it had just joined.
 */
export function upsertFallbackOffersSql(listingScope = ""): string {
  return `
    INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
    SELECT p.id, e.id, p.shop_key
    FROM products p
    JOIN product_search_entities e ON e.entity_key = 'l-' || (${fallbackRepresentativeListingIdSql("p")})
    WHERE p.is_active = 1
      AND NOT EXISTS (
        SELECT 1 FROM product_identity_resolutions r
        JOIN knowledge_catalog_products kp
          ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
        WHERE r.listing_product_id = p.id AND r.status = 'matched'
      )${listingScope}
    ON CONFLICT(listing_product_id) DO UPDATE SET
      entity_id = excluded.entity_id,
      shop_key = excluded.shop_key
    WHERE product_search_entity_offers.entity_id IS NOT excluded.entity_id
       OR product_search_entity_offers.shop_key IS NOT excluded.shop_key
  `;
}

/**
 * Recomputes the stored offer aggregates that sorting and the card summary read.
 *
 * Deliberately excludes the FTS-backed columns so re-aggregating a price change does not force the
 * search index to be rewritten; {@link refreshEntitySearchTermsSql} owns those.
 */
export function refreshEntityAggregatesSql(entityScope = ""): string {
  return `
    UPDATE product_search_entities AS e
    SET manufacturer = COALESCE(agg.display_manufacturer, e.manufacturer),
        offer_count = agg.offer_count,
        in_stock_offer_count = agg.in_stock_offer_count,
        sold_out_offer_count = agg.sold_out_offer_count,
        shop_count = agg.shop_count,
        lowest_price_yen = agg.lowest_price_yen,
        lowest_in_stock_price_yen = agg.lowest_in_stock_price_yen,
        highest_price_yen = agg.highest_price_yen,
        latest_activity_at = agg.latest_activity_at,
        newest_listed_at = agg.newest_listed_at,
        has_price_drop = agg.has_price_drop
    FROM (
      SELECT m.entity_id AS entity_id,
             MIN(NULLIF(p.manufacturer, '')) AS display_manufacturer,
             COUNT(*) AS offer_count,
             SUM(CASE WHEN p.stock_status = 'in_stock' THEN 1 ELSE 0 END) AS in_stock_offer_count,
             SUM(CASE WHEN p.stock_status = 'sold_out' THEN 1 ELSE 0 END) AS sold_out_offer_count,
             COUNT(DISTINCT p.shop_key) AS shop_count,
             MIN(p.price_yen) AS lowest_price_yen,
             MIN(CASE WHEN p.stock_status = 'in_stock' THEN p.price_yen END) AS lowest_in_stock_price_yen,
             MAX(p.price_yen) AS highest_price_yen,
             MAX(p.last_activity_at) AS latest_activity_at,
             MAX(COALESCE(p.source_published_at, p.first_seen_at)) AS newest_listed_at,
             MAX(CASE
                   WHEN p.previous_price_yen IS NOT NULL AND p.price_yen IS NOT NULL
                        AND p.price_yen < p.previous_price_yen THEN 1
                   ELSE 0
                 END) AS has_price_drop
      FROM product_search_entity_offers m
      JOIN products p ON p.id = m.listing_product_id
      WHERE p.is_active = 1${entityScope}
      GROUP BY m.entity_id
    ) AS agg
    WHERE e.id = agg.entity_id
      AND (e.manufacturer IS NOT COALESCE(agg.display_manufacturer, e.manufacturer)
        OR e.offer_count IS NOT agg.offer_count
        OR e.in_stock_offer_count IS NOT agg.in_stock_offer_count
        OR e.sold_out_offer_count IS NOT agg.sold_out_offer_count
        OR e.shop_count IS NOT agg.shop_count
        OR e.lowest_price_yen IS NOT agg.lowest_price_yen
        OR e.lowest_in_stock_price_yen IS NOT agg.lowest_in_stock_price_yen
        OR e.highest_price_yen IS NOT agg.highest_price_yen
        OR e.latest_activity_at IS NOT agg.latest_activity_at
        OR e.newest_listed_at IS NOT agg.newest_listed_at
        OR e.has_price_drop IS NOT agg.has_price_drop)
  `;
}

/**
 * Recomputes the finishes an entity's offers are in.
 *
 * Its own statement for the same reason the search terms are: {@link refreshEntityAggregatesSql} is
 * copied verbatim into the repair migrations that replay it, so growing it would leave those
 * migrations describing SQL that no longer exists. A finish also changes on a different cadence
 * from a price — only when a listing joins, leaves, or is re-resolved.
 *
 * `group_concat` gives no ordering guarantee, which is deliberate here: the read mapper orders the
 * labels by the finish catalog, so the card is stable however SQLite happened to concatenate them.
 */
export function refreshEntityPresentationColorsSql(entityScope = ""): string {
  return `
    UPDATE product_search_entities AS e
    SET presentation_colors = agg.presentation_colors
    FROM (
      SELECT m.entity_id AS entity_id,
             COALESCE(group_concat(DISTINCT NULLIF(p.presentation_color, '')), '') AS presentation_colors
      FROM product_search_entity_offers m
      JOIN products p ON p.id = m.listing_product_id
      WHERE p.is_active = 1${entityScope}
      GROUP BY m.entity_id
    ) AS agg
    WHERE e.id = agg.entity_id AND e.presentation_colors IS NOT agg.presentation_colors
  `;
}

/** How many member listings may contribute seller evidence to one entity's search terms. */
export const SEARCH_TERM_OFFER_SAMPLE = 3;

/**
 * Folds bounded seller evidence into the entity's searchable text.
 *
 * Canonical manufacturer/model terms are owned by the entity upsert; this only adds titles and the
 * shops' own normalized terms so a query phrased the way a retailer writes it still finds the
 * product. The `IS NOT` guard keeps unchanged text from rewriting the FTS index every crawl.
 */
export function refreshEntitySearchTermsSql(entityScope = ""): string {
  return `
    UPDATE product_search_entities AS e
    SET title_terms = agg.title_terms,
        category_terms = agg.category_terms
    FROM (
      SELECT t.entity_id AS entity_id,
             TRIM(COALESCE(group_concat(t.title_terms, ' '), '')) AS title_terms,
             TRIM(COALESCE(group_concat(t.category_terms, ' '), '')) AS category_terms
      FROM (
        SELECT m.entity_id AS entity_id,
               TRIM(
                 COALESCE(NULLIF(sp.title, ''), p.title) || ' ' ||
                 COALESCE(sp.manufacturer_terms, '') || ' ' ||
                 COALESCE(sp.model_terms, '')
               ) AS title_terms,
               COALESCE(NULLIF(sp.category_terms, ''), p.category) AS category_terms,
               ROW_NUMBER() OVER (PARTITION BY m.entity_id ORDER BY p.id) AS rn
        FROM product_search_entity_offers m
        JOIN products p ON p.id = m.listing_product_id
        LEFT JOIN product_search_projection sp ON sp.product_id = p.id
        WHERE p.is_active = 1${entityScope}
      ) t
      WHERE t.rn <= ${SEARCH_TERM_OFFER_SAMPLE}
      GROUP BY t.entity_id
    ) AS agg
    WHERE e.id = agg.entity_id
      AND (e.title_terms IS NOT agg.title_terms OR e.category_terms IS NOT agg.category_terms)
  `;
}

/**
 * Projects an entity's category membership from the listings currently offering it.
 *
 * Upsert rather than delete-and-reinsert: these statements are not run inside one transaction, and
 * emptying an entity's categories first would make it briefly unfilterable — invisible in category
 * search for the width of the gap. {@link deleteStaleEntityCategoriesSql} removes what is no
 * longer justified afterwards, so membership only ever grows before it shrinks.
 *
 * `MAX(pc.is_direct)` because directness is a property of the strongest claim: if any active offer
 * has a component product directly in the category, the entity is directly in it.
 */
export function upsertEntityCategoriesSql(offerScope = ""): string {
  return `
    INSERT INTO product_search_entity_categories(entity_id, category_id, is_direct)
    SELECT m.entity_id, pc.category_id, MAX(pc.is_direct)
    FROM product_search_entity_offers m
    JOIN products p ON p.id = m.listing_product_id
    JOIN product_categories pc ON pc.product_id = m.listing_product_id
    WHERE p.is_active = 1${offerScope}
    GROUP BY m.entity_id, pc.category_id
    ON CONFLICT(entity_id, category_id) DO UPDATE SET is_direct = excluded.is_direct
    WHERE product_search_entity_categories.is_direct IS NOT excluded.is_direct
  `;
}

/**
 * Drops membership no active offer justifies any more.
 *
 * The half that retires a category when the listing that carried it sold out, was re-classified,
 * or moved to another entity.
 */
export function deleteStaleEntityCategoriesSql(entityScope = ""): string {
  return `
    DELETE FROM product_search_entity_categories
    WHERE NOT EXISTS (
      SELECT 1
      FROM product_search_entity_offers m
      JOIN products p ON p.id = m.listing_product_id
      JOIN product_categories pc ON pc.product_id = m.listing_product_id
      WHERE m.entity_id = product_search_entity_categories.entity_id
        AND pc.category_id = product_search_entity_categories.category_id
        AND p.is_active = 1
    )${entityScope}
  `;
}

/**
 * Removes entities that no longer have an active offer.
 *
 * This is what retires a fallback entity once its listing becomes `matched`, and what retires a
 * canonical entity once every shop has sold out of it.
 */
export function deleteEmptyEntitiesSql(entityScope = ""): string {
  return `
    DELETE FROM product_search_entities
    WHERE NOT EXISTS (
      SELECT 1 FROM product_search_entity_offers m WHERE m.entity_id = product_search_entities.id
    )${entityScope}
  `;
}

/** Finish pending correction evidence even when the final offer membership did not change. */
export function completeEntityMembershipProvenanceSql(listingScope = ""): string {
  return `
    UPDATE data_quality_remediation_events AS event
    SET new_identity_resolution = COALESCE((
          SELECT r.status || ':' || r.match_method || ':' ||
                 COALESCE(CAST(r.catalog_product_id AS TEXT), '-')
          FROM product_identity_resolutions r WHERE r.listing_product_id = event.listing_product_id
        ), 'none'),
        new_search_entity_key = (
          SELECT e.entity_key FROM product_search_entity_offers m
          JOIN product_search_entities e ON e.id = m.entity_id
          WHERE m.listing_product_id = event.listing_product_id
        ),
        provenance_complete = 1
    WHERE event.provenance_complete = 0 AND event.listing_product_id IN (
      SELECT p.id FROM products p
      JOIN product_search_entity_offers m ON m.listing_product_id = p.id
      WHERE p.is_active = 1${listingScope}
    )
  `;
}
