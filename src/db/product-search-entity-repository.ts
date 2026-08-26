/**
 * Maintenance of the product-level search read model.
 *
 * Three entry points share one definition of what an entity is (see `product-search-entity-sql.ts`):
 *
 * - {@link syncProductSearchEntities} runs after every crawl, scoped to the listings that shop just
 *   reported plus any of its listings that went inactive since the last pass;
 * - {@link rebuildProductSearchEntities} re-derives the whole model and is safe to run repeatedly;
 * - {@link productSearchEntityConsistency} reports drift instead of waiting for a user to notice a
 *   product that stopped being searchable.
 *
 * Verified Knowledge Catalog identities are authoritative. Before a product reaches that state,
 * resolved exact manufacturer/model peers may share one representative fallback entity; see
 * `product-search-exact-identity.ts`. Reads never repair the projection they consume.
 */

import {
  exactIdentityPeerIdsSql,
  upsertExactIdentityGroupOffersSql,
} from "./product-search-exact-identity.js";
import {
  deleteEmptyEntitiesSql,
  deleteInactiveOffersSql,
  refreshEntityAggregatesSql,
  refreshEntityPresentationColorsSql,
  refreshEntitySearchTermsSql,
  scopeClause,
  upsertCatalogEntitiesSql,
  upsertCatalogOffersSql,
  upsertFallbackEntitiesSql,
  upsertFallbackOffersSql,
} from "./product-search-entity-sql.js";
import type {
  ProductSearchEntityConsistency,
  ProductSearchEntityRebuildResult,
  ProductSearchEntitySyncResult,
  QueryableDatabase,
} from "./types.js";

/** D1 caps bound variables per statement; every scoped statement stays well below that limit. */
const CHUNK_SIZE = 40;

function chunks<T>(values: readonly T[], size = CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

async function runStatement(
  db: QueryableDatabase,
  sql: string,
  binds: readonly unknown[] = [],
): Promise<number> {
  const result = await db
    .prepare(sql)
    .bind(...binds)
    .run();
  return Number(result?.meta?.changes || 0);
}

interface ProjectionBatchStatement {
  sql: string;
  binds: readonly unknown[];
  countsAsRemoval?: boolean;
}

/**
 * D1 `batch()` is a transaction. Keeping entity creation, membership movement and scoped empty
 * entity pruning in one batch prevents a Worker termination from committing only half of a
 * Product Search projection transition.
 */
async function runProjectionBatch(
  db: QueryableDatabase,
  statements: readonly ProjectionBatchStatement[],
): Promise<number> {
  const results = await db.batch(
    statements.map(({ sql, binds }) => db.prepare(sql).bind(...binds)),
  );
  return results.reduce(
    (removed, result, index) =>
      removed + (statements[index]?.countsAsRemoval ? Number(result?.meta?.changes || 0) : 0),
    0,
  );
}

async function selectNumbers(
  db: QueryableDatabase,
  sql: string,
  binds: readonly unknown[],
  column: string,
): Promise<number[]> {
  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<Record<string, number>>();
  return (result.results || []).map((row) => Number(row[column]));
}

/** Listing ids for the source ids a shop just reported. */
async function listingIdsForSources(
  db: QueryableDatabase,
  shopKey: string,
  sourceIds: readonly string[],
): Promise<number[]> {
  const ids = [...new Set(sourceIds.filter(Boolean))];
  const found: number[] = [];
  for (const chunk of chunks(ids)) {
    const placeholders = chunk.map(() => "?").join(",");
    found.push(
      ...(await selectNumbers(
        db,
        `SELECT id FROM products WHERE shop_key = ? AND source_id IN (${placeholders})`,
        [shopKey, ...chunk],
        "id",
      )),
    );
  }
  return found;
}

/**
 * Safe unresolved peers of the listings being changed.
 *
 * Incremental sync has to rewrite both sides of a newly discovered exact identity. Otherwise the
 * new offer would move into the shared fallback entity while an older shop's offer remained in its
 * previous per-listing entity until the next global rebuild.
 */
async function exactIdentityPeerListingIds(
  db: QueryableDatabase,
  listingIds: readonly number[],
): Promise<number[]> {
  const found: number[] = [];
  for (const chunk of chunks(listingIds)) {
    found.push(...(await selectNumbers(db, exactIdentityPeerIdsSql(chunk.length), chunk, "id")));
  }
  return found;
}

/** Entities the given listings belong to, plus any fallback entity minted for them. */
async function entityIdsForListings(
  db: QueryableDatabase,
  listingIds: readonly number[],
): Promise<number[]> {
  const found: number[] = [];
  for (const chunk of chunks(listingIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    found.push(
      ...(await selectNumbers(
        db,
        `SELECT DISTINCT entity_id AS entity_id FROM product_search_entity_offers
         WHERE listing_product_id IN (${placeholders})`,
        chunk,
        "entity_id",
      )),
      ...(await selectNumbers(
        db,
        `SELECT id AS entity_id FROM product_search_entities
         WHERE fallback_listing_id IN (${placeholders})`,
        chunk,
        "entity_id",
      )),
    );
  }
  return found;
}

function emptyEntityPruneStatements(
  entityIds: readonly number[],
  listingIds: readonly number[],
): ProjectionBatchStatement[] {
  const statements: ProjectionBatchStatement[] = [];
  for (const entityChunk of chunks([...new Set(entityIds)])) {
    statements.push({
      sql: deleteEmptyEntitiesSql(scopeClause("id", entityChunk.length)),
      binds: entityChunk,
      countsAsRemoval: true,
    });
  }
  for (const listingChunk of chunks([...new Set(listingIds)])) {
    statements.push({
      sql: deleteEmptyEntitiesSql(scopeClause("fallback_listing_id", listingChunk.length)),
      binds: listingChunk,
      countsAsRemoval: true,
    });
  }
  return statements;
}

async function refreshEntities(
  db: QueryableDatabase,
  entityIds: readonly number[],
): Promise<{ refreshedCount: number; removedCount: number }> {
  let removedCount = 0;
  for (const chunk of chunks(entityIds)) {
    const offerScope = scopeClause("m.entity_id", chunk.length);
    await runStatement(db, refreshEntityAggregatesSql(offerScope), chunk);
    await runStatement(db, refreshEntityPresentationColorsSql(offerScope), chunk);
    await runStatement(db, refreshEntitySearchTermsSql(offerScope), chunk);
    removedCount += await runStatement(
      db,
      deleteEmptyEntitiesSql(scopeClause("id", chunk.length)),
      chunk,
    );
  }
  return { refreshedCount: entityIds.length, removedCount };
}

/**
 * Brings the product-level model in line with the listings it is given.
 *
 * Entity rows are written before membership so a member always has an entity to point at. Each
 * listing chunk is committed as one D1 batch transaction, including pruning entities the chunk
 * leaves behind and transient per-listing fallback entities superseded by exact-identity grouping.
 * The affected entity set is still captured before and after the rewrite so surviving entities get
 * their stored aggregates and FTS evidence refreshed.
 *
 * Strictly scoped to `sourceIds` and the identity peers they regroup. Retiring the memberships of
 * listings that disappeared is a shop-wide question, and answering it here made the cost of every
 * call depend on the size of the shop rather than on the work asked for; it belongs to the crawl's
 * `membership_cleanup` stage, which walks the same set in bounded chunks.
 */
export async function syncProductSearchEntities(
  db: QueryableDatabase,
  shopKey: string,
  sourceIds: readonly string[] = [],
): Promise<ProductSearchEntitySyncResult> {
  const seeds = [...new Set(await listingIdsForSources(db, shopKey, sourceIds))];
  if (!seeds.length) {
    return { listing_count: 0, entity_count: 0, removed_entity_count: 0 };
  }

  const peers = await exactIdentityPeerListingIds(db, seeds);
  // Numeric order is load-bearing for groups larger than one D1 chunk: the representative is the
  // minimum eligible listing id, so its fallback entity must be created before later peer chunks
  // try to point at it.
  const listingIds = [...new Set([...seeds, ...peers])].sort((left, right) => left - right);

  const before = new Set<number>();
  let removedDuringProjection = 0;
  for (const chunk of chunks(listingIds)) {
    const chunkBefore = [...new Set(await entityIdsForListings(db, chunk))];
    for (const entityId of chunkBefore) before.add(entityId);

    const listingScope = scopeClause("p.id", chunk.length);
    removedDuringProjection += await runProjectionBatch(db, [
      { sql: upsertCatalogEntitiesSql(listingScope), binds: chunk },
      { sql: upsertFallbackEntitiesSql(listingScope), binds: chunk },
      { sql: deleteInactiveOffersSql(listingScope), binds: chunk },
      { sql: upsertCatalogOffersSql(listingScope), binds: chunk },
      { sql: upsertFallbackOffersSql(listingScope), binds: chunk },
      { sql: upsertExactIdentityGroupOffersSql(listingScope), binds: chunk },
      ...emptyEntityPruneStatements(chunkBefore, chunk),
    ]);
  }
  const after = await entityIdsForListings(db, listingIds);

  const affected = [...new Set([...before, ...after])];
  const { removedCount } = await refreshEntities(db, affected);
  return {
    listing_count: listingIds.length,
    entity_count: affected.length,
    removed_entity_count: removedDuringProjection + removedCount,
  };
}

/**
 * Re-derives every entity from listings, identity resolutions and the Knowledge Catalog.
 *
 * The repair path for migration recovery, local development and production drift. Idempotent:
 * `entity_key` and `listing_product_id` are unique, so a second run converges on the same rows.
 */
export async function rebuildProductSearchEntities(
  db: QueryableDatabase,
): Promise<ProductSearchEntityRebuildResult> {
  await runStatement(db, upsertCatalogEntitiesSql());
  await runStatement(db, upsertFallbackEntitiesSql());
  await runStatement(db, deleteInactiveOffersSql());
  const catalogOffers = await runStatement(db, upsertCatalogOffersSql());
  const fallbackOffers = await runStatement(db, upsertFallbackOffersSql());
  const exactIdentityOffers = await runStatement(db, upsertExactIdentityGroupOffersSql());
  await runStatement(db, refreshEntityAggregatesSql());
  await runStatement(db, refreshEntityPresentationColorsSql());
  await runStatement(db, refreshEntitySearchTermsSql());
  const removed = await runStatement(db, deleteEmptyEntitiesSql());
  const totals = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM product_search_entities) AS entity_count,
         (SELECT COUNT(*) FROM product_search_entity_offers) AS offer_count`,
    )
    .bind()
    .first<{ entity_count: number; offer_count: number }>();
  const result: ProductSearchEntityRebuildResult = {
    event: "product_search_entity_rebuild",
    entity_count: Number(totals?.entity_count || 0),
    offer_count: Number(totals?.offer_count || 0),
    membership_write_count: catalogOffers + fallbackOffers + exactIdentityOffers,
    removed_entity_count: removed,
  };
  console.log(JSON.stringify(result));
  return result;
}

const CONSISTENCY_SQL = `
  SELECT
    (SELECT COUNT(*) FROM products p
      WHERE p.is_active = 1
        AND NOT EXISTS (SELECT 1 FROM product_search_entity_offers m WHERE m.listing_product_id = p.id)
    ) AS unmembered_active_listings,
    (SELECT COUNT(*) FROM product_search_entity_offers m
      JOIN products p ON p.id = m.listing_product_id
      WHERE p.is_active = 0
    ) AS inactive_offer_memberships,
    (SELECT COUNT(*) FROM product_search_entities e
      WHERE NOT EXISTS (SELECT 1 FROM product_search_entity_offers m WHERE m.entity_id = e.id)
    ) AS entities_without_offers,
    (SELECT COUNT(*) FROM product_search_entities e
      WHERE e.entity_kind = 'unresolved_listing'
        AND EXISTS (
          SELECT 1 FROM product_identity_resolutions r
          JOIN knowledge_catalog_products kp
            ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
          WHERE r.listing_product_id = e.fallback_listing_id AND r.status = 'matched'
        )
    ) AS stale_fallback_entities,
    (SELECT COUNT(*) FROM product_search_entities e
      WHERE e.entity_kind = 'catalog'
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_catalog_products kp
          WHERE kp.id = e.catalog_product_id AND kp.verification_status = 'verified'
        )
    ) AS ineligible_catalog_entities,
    (SELECT COUNT(*) FROM product_search_entities e
      WHERE e.offer_count <> (
        SELECT COUNT(*) FROM product_search_entity_offers m
        JOIN products p ON p.id = m.listing_product_id
        WHERE m.entity_id = e.id AND p.is_active = 1
      )
    ) AS offer_count_mismatches
`;

/**
 * Drift metrics for the product search projection.
 *
 * Every number should be zero. A non-zero value names exactly which invariant broke, which is what
 * makes {@link rebuildProductSearchEntities} an informed repair rather than a ritual.
 */
export async function productSearchEntityConsistency(
  db: QueryableDatabase,
): Promise<ProductSearchEntityConsistency> {
  const row = await db.prepare(CONSISTENCY_SQL).bind().first<Record<string, number>>();
  let ftsIntegrityOk = true;
  try {
    await db
      .prepare(
        "INSERT INTO product_search_entities_fts(product_search_entities_fts) VALUES('integrity-check')",
      )
      .bind()
      .run();
  } catch {
    ftsIntegrityOk = false;
  }
  const counts = {
    unmembered_active_listings: Number(row?.unmembered_active_listings || 0),
    inactive_offer_memberships: Number(row?.inactive_offer_memberships || 0),
    entities_without_offers: Number(row?.entities_without_offers || 0),
    stale_fallback_entities: Number(row?.stale_fallback_entities || 0),
    ineligible_catalog_entities: Number(row?.ineligible_catalog_entities || 0),
    offer_count_mismatches: Number(row?.offer_count_mismatches || 0),
  };
  return {
    ...counts,
    fts_integrity_ok: ftsIntegrityOk,
    ok: ftsIntegrityOk && Object.values(counts).every((value) => value === 0),
  };
}
