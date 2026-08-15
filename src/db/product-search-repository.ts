/**
 * The one production implementation of product search.
 *
 * The unit of every read here is a *search entity* — a confirmed Knowledge Catalog product with all
 * of its shops' offers, or a single unresolved listing standing in for itself — never a seller
 * listing. That distinction is what makes counts, pagination and ranking mean what a user expects
 * when three shops list the same amplifier: filtering, ordering and `LIMIT` all happen over
 * entities before a single offer is loaded, so a product can neither appear twice on one page nor
 * fall through the gap between two.
 *
 * Filters split along the same line, and the split is load-bearing:
 *
 * - product-level (`manufacturer`, `category`, `feature`) restrict the entity itself;
 * - offer-level (`shop`, `inStock`, `minPrice`, `maxPrice`, `newOnly`, `priceDropped`) are
 *   evaluated inside a single `EXISTS` so they must all hold for the *same* offer. Satisfying
 *   `shop=A` with one listing and `maxPrice` with another shop's listing would be a wrong answer,
 *   not a lenient one.
 *
 * Offer data is loaded with a bounded number of queries per request — never one per result. At the
 * maximum page size a response costs at most eight statements: an optional count, the entity page,
 * and up to three chunks each for filtered aggregates and representative offers.
 */

import { categoryFilterIds } from "../catalog/categories.js";
import { normalizeIdentityModel } from "../catalog/product-identity.js";
import { manufacturerFilterIds, splitKnownManufacturerModel } from "../catalog/manufacturers.js";
import { parseFtsSearchQuery } from "../search/fts-query.js";
import type { FtsSearchPlan } from "../search/fts-query.js";
import { usesRelevanceOrder } from "../api/product-query.js";
import type { ProductQuery } from "../api/product-query.js";
import type {
  ProductSearchDetailResponse,
  ProductSearchItem,
  ProductSearchResponse,
} from "../api/contracts.js";
import { parseProductSearchKey } from "../api/product-search-key.js";
import {
  addCursorPredicate,
  cursorFor,
  decodeCursor,
  sortDefinition,
  sortOrderBy,
} from "./product-search-cursor.js";
import {
  entityColumns,
  offerColumns,
  offerProjectionColumns,
  toProductOffer,
  toProductSearchItem,
} from "./product-search-entity-mapper.js";
import { newOfferPredicate } from "./product-search-entity-sql.js";
import type {
  ProductSearchEntityRow,
  ProductSearchOfferAggregateRow,
  ProductSearchOfferRow,
  ProductSearchSortDefinition,
  QueryableDatabase,
} from "./types.js";

/**
 * Offers returned by the detail endpoint for one product.
 *
 * Generous enough that no realistic product is truncated, but bounded so a pathological entity
 * cannot turn a point read into an unbounded scan.
 */
export const MAX_DETAIL_OFFERS = 200;

/**
 * Entity ids per offer query.
 *
 * D1 caps bound parameters per statement at 100, and a full `limit=100` page plus the offer filter
 * binds would exceed that. Chunking keeps the offer loaders bounded by the page size rather than by
 * the result count — at most three statements each, never one per result.
 */
const OFFER_QUERY_CHUNK_SIZE = 40;

function chunked(values: readonly number[]): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < values.length; i += OFFER_QUERY_CHUNK_SIZE) {
    chunks.push(values.slice(i, i + OFFER_QUERY_CHUNK_SIZE));
  }
  return chunks;
}

/** Ranks the offer a card shows: in stock first, then cheapest, then most recently active. */
const REPRESENTATIVE_OFFER_ORDER = `
  CASE WHEN p.stock_status = 'in_stock' THEN 0 ELSE 1 END,
  CASE WHEN p.price_yen IS NULL THEN 1 ELSE 0 END,
  p.price_yen ASC,
  p.last_activity_at DESC,
  p.id ASC
`;

interface SearchPlanResult {
  join: string;
  plan: FtsSearchPlan | null;
}

/** The predicates every offer of a product must satisfy together, plus their binds. */
interface OfferFilter {
  sql: string;
  binds: unknown[];
  active: boolean;
}

interface ProductSearchPageRow extends ProductSearchEntityRow {
  /** Present only when ORDER BY was computed from the matching offer subset. */
  request_sort_value?: string | number | null;
}

/**
 * Joins the entity FTS index and adds the matching predicates.
 *
 * Terms of three or more code points go through FTS5; shorter ones (`SE`, `MC`) are too small for
 * the trigram tokenizer and fall back to bounded LIKE scans over the same entity columns, so a
 * short model name still returns results instead of nothing.
 */
function addSearchPlan(q: string, where: string[], binds: unknown[]): SearchPlanResult {
  if (!q) return { join: "", plan: null };
  const plan = parseFtsSearchQuery(q);
  let join = "";
  if (plan.ftsQuery) {
    join = " JOIN product_search_entities_fts ON product_search_entities_fts.rowid = e.id";
    where.push("product_search_entities_fts MATCH ?");
    binds.push(plan.ftsQuery);
  }
  for (const value of plan.shortTerms) {
    const term = `%${value}%`;
    where.push(`(
      e.manufacturer_terms LIKE ? OR e.normalized_model LIKE ? OR e.model_terms LIKE ?
      OR e.title_terms LIKE ? OR e.category_terms LIKE ?
    )`);
    binds.push(term, term, term, term, term);
  }
  return { join, plan };
}

/**
 * Exact manufacturer+model beats exact model, which beats an exact canonical model, then bm25.
 *
 * Ranking reads canonical entity columns, so a product cannot climb the results merely by being
 * listed in more shops — the number of offers is invisible to relevance by construction.
 */
function relevanceOrder(q: string, plan: FtsSearchPlan | null, rankBinds: unknown[]): string {
  const known = splitKnownManufacturerModel(q);
  const queryModel = known?.model || q;
  const normalizedModel = normalizeIdentityModel(queryModel);
  const cases = [];
  if (known?.id && normalizedModel) {
    cases.push("WHEN e.manufacturer_id = ? AND e.normalized_model = ? THEN 0");
    rankBinds.push(known.id, normalizedModel);
  }
  if (normalizedModel) {
    cases.push("WHEN e.normalized_model = ? THEN 1");
    rankBinds.push(normalizedModel);
  }
  cases.push("WHEN LOWER(e.model) = LOWER(?) THEN 2");
  rankBinds.push(q);
  const caseSql = `CASE ${cases.join(" ")} ELSE 3 END ASC`;
  const ftsRank = plan?.ftsQuery
    ? ", bm25(product_search_entities_fts, 8.0, 7.0, 6.0, 4.0, 1.0) ASC"
    : "";
  return `${caseSql}${ftsRank}, e.latest_activity_at DESC, e.id DESC`;
}

/** Product-level filters: they describe the product, so they never look at an individual offer. */
function addProductFilters(query: ProductQuery, where: string[], binds: unknown[]): void {
  if (query.manufacturer) {
    // During a resolver-version replay, the public facet may already expose the canonical display
    // while an entity still carries the previous fallback id (for example `msb`). Match every id
    // that the known alias set could historically have produced until the replay converges.
    const manufacturerIds = manufacturerFilterIds(query.manufacturer);
    if (manufacturerIds.length) {
      where.push(
        `(e.manufacturer_id IN (${manufacturerIds.map(() => "?").join(",")}) OR e.manufacturer = ?)`,
      );
      binds.push(...manufacturerIds, query.manufacturer);
    } else {
      where.push("e.manufacturer = ?");
      binds.push(query.manufacturer);
    }
  }
  if (query.category) {
    const categoryIds = categoryFilterIds(query.category);
    if (categoryIds.length) {
      where.push(`e.primary_category_id IN (${categoryIds.map(() => "?").join(",")})`);
      binds.push(...categoryIds);
    } else {
      where.push("e.primary_category_id = ?");
      binds.push(query.category);
    }
  }
  for (const feature of query.features) {
    // A model property, so evidence from any of the product's listings establishes it.
    where.push(`EXISTS (
      SELECT 1 FROM product_search_entity_offers m
      JOIN product_feature_facts pff ON pff.product_id = m.listing_product_id
      WHERE m.entity_id = e.id AND pff.feature_id = ? AND pff.state = 'present'
    )`);
    binds.push(feature);
  }
}

/**
 * The offer-level predicate, as one conjunction to be evaluated against a single listing row.
 *
 * Returned rather than appended so the identical predicate can be reused by the summary,
 * representative-offer and request-scoped sort queries. The numbers on a card and the sort key are
 * therefore computed over exactly the offers that made the product match.
 */
function offerFilter(query: ProductQuery): OfferFilter {
  const predicates: string[] = [];
  const binds: unknown[] = [];
  if (query.shop) {
    predicates.push("p.shop_key = ?");
    binds.push(query.shop);
  }
  if (query.inStock) predicates.push("p.stock_status = 'in_stock'");
  if (query.newOnly) predicates.push(newOfferPredicate("p"));
  if (query.priceDropped) {
    predicates.push(
      "(p.previous_price_yen IS NOT NULL AND p.price_yen IS NOT NULL AND p.price_yen < p.previous_price_yen)",
    );
  }
  if (query.minPrice != null) {
    predicates.push("p.price_yen >= ?");
    binds.push(query.minPrice);
  }
  if (query.maxPrice != null) {
    predicates.push("p.price_yen <= ?");
    binds.push(query.maxPrice);
  }
  return {
    sql: predicates.length ? ` AND ${predicates.join(" AND ")}` : "",
    binds,
    active: predicates.length > 0,
  };
}

/**
 * Keeps a product only when one offer satisfies every offer-level predicate at once.
 *
 * Entities always hold at least one active offer, so with no offer filters there is nothing to
 * add and the entity indexes can serve the query on their own.
 */
function addOfferFilter(filter: OfferFilter, where: string[], binds: unknown[]): void {
  if (!filter.active) return;
  where.push(`EXISTS (
    SELECT 1 FROM product_search_entity_offers m
    JOIN products p ON p.id = m.listing_product_id
    WHERE m.entity_id = e.id AND p.is_active = 1${filter.sql}
  )`);
  binds.push(...filter.binds);
}

/**
 * Stored entity aggregates are valid only while the request has not narrowed the relevant offers.
 *
 * The in-stock-only price case is the one exception: `lowest_in_stock_price_yen` is already stored
 * specifically for that predicate. Every other offer filter changes the value the user sees, so an
 * explicit sort must use the same matching subset.
 */
function needsRequestScopedSort(
  query: ProductQuery,
  filter: OfferFilter,
  relevance: boolean,
): boolean {
  if (relevance || !filter.active) return false;
  if (query.sort !== "priceAsc" && query.sort !== "priceDesc") return true;
  return Boolean(
    query.shop ||
    query.newOnly ||
    query.priceDropped ||
    query.minPrice != null ||
    query.maxPrice != null,
  );
}

/** A stable cursor namespace for an ordering derived from request-level offer predicates. */
function offerSortScopeKey(query: ProductQuery): string {
  return [
    query.shop,
    query.inStock ? "1" : "0",
    query.newOnly ? "1" : "0",
    query.priceDropped ? "1" : "0",
    query.minPrice == null ? "" : String(query.minPrice),
    query.maxPrice == null ? "" : String(query.maxPrice),
  ]
    .map((value) => encodeURIComponent(value))
    .join("|");
}

/**
 * Aggregate sort values over exactly the offers accepted by {@link offerFilter}.
 *
 * This is an inner join, so it also proves a matching offer exists. The existing `EXISTS` remains
 * in the WHERE clause because the count query shares that predicate and must not depend on ORDER BY.
 */
function requestScopedSortJoin(filter: OfferFilter): string {
  return ` JOIN (
    SELECT m.entity_id AS entity_id,
           MIN(p.price_yen) AS lowest_price_yen,
           MIN(CASE WHEN p.stock_status = 'in_stock' THEN p.price_yen END) AS lowest_in_stock_price_yen,
           MAX(p.last_activity_at) AS latest_activity_at,
           MAX(COALESCE(p.source_published_at, p.first_seen_at)) AS newest_listed_at
    FROM product_search_entity_offers m
    JOIN products p ON p.id = m.listing_product_id
    WHERE p.is_active = 1${filter.sql}
    GROUP BY m.entity_id
  ) matching_sort ON matching_sort.entity_id = e.id`;
}

/** Recomputes the card summary over the matching offers, so it cannot contradict the filter. */
async function loadOfferAggregates(
  db: QueryableDatabase,
  entityIds: readonly number[],
  filter: OfferFilter,
): Promise<Map<number, ProductSearchOfferAggregateRow>> {
  if (!entityIds.length || !filter.active) return new Map();
  const aggregates = new Map<number, ProductSearchOfferAggregateRow>();
  for (const chunk of chunked(entityIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT m.entity_id AS entity_id,
               COUNT(*) AS offer_count,
               SUM(CASE WHEN p.stock_status = 'in_stock' THEN 1 ELSE 0 END) AS in_stock_offer_count,
               SUM(CASE WHEN p.stock_status = 'sold_out' THEN 1 ELSE 0 END) AS sold_out_offer_count,
               COUNT(DISTINCT p.shop_key) AS shop_count,
               MIN(p.price_yen) AS lowest_price_yen,
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
        WHERE m.entity_id IN (${placeholders}) AND p.is_active = 1${filter.sql}
        GROUP BY m.entity_id
      `)
      .bind(...chunk, ...filter.binds)
      .all<ProductSearchOfferAggregateRow>();
    for (const row of result.results || []) aggregates.set(Number(row.entity_id), row);
  }
  return aggregates;
}

/** One representative offer per product, in a single windowed query rather than one per result. */
async function loadRepresentativeOffers(
  db: QueryableDatabase,
  entityIds: readonly number[],
  filter: OfferFilter,
): Promise<Map<number, ProductSearchOfferRow>> {
  if (!entityIds.length) return new Map();
  const representatives = new Map<number, ProductSearchOfferRow>();
  for (const chunk of chunked(entityIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT entity_id, ${offerProjectionColumns()} FROM (
          SELECT m.entity_id AS entity_id, ${offerColumns("p")},
                 ROW_NUMBER() OVER (
                   PARTITION BY m.entity_id ORDER BY ${REPRESENTATIVE_OFFER_ORDER}
                 ) AS rn
          FROM product_search_entity_offers m
          JOIN products p ON p.id = m.listing_product_id
          WHERE m.entity_id IN (${placeholders}) AND p.is_active = 1${filter.sql}
        )
        WHERE rn = 1
      `)
      .bind(...chunk, ...filter.binds)
      .all<ProductSearchOfferRow>();
    for (const row of result.results || []) representatives.set(Number(row.entity_id), row);
  }
  return representatives;
}

export async function searchProducts(
  db: QueryableDatabase,
  query: ProductQuery,
): Promise<ProductSearchResponse> {
  const startedAt = Date.now();
  const where: string[] = [];
  const binds: unknown[] = [];
  const search = addSearchPlan(query.q, where, binds);
  addProductFilters(query, where, binds);
  const filter = offerFilter(query);
  addOfferFilter(filter, where, binds);

  // Snapshot before the cursor predicate: the total must count the whole result set.
  const countWhere = [...where];
  const countBinds = [...binds];
  const relevance = usesRelevanceOrder(query);
  const baseSort = sortDefinition(query.sort, query.inStock);
  const requestScopedSort = needsRequestScopedSort(query, filter, relevance);
  const sort: ProductSearchSortDefinition = requestScopedSort
    ? { ...baseSort, key: `${baseSort.key}|offers:${offerSortScopeKey(query)}` }
    : baseSort;
  const sortColumn = requestScopedSort ? `matching_sort.${sort.column}` : `e.${sort.column}`;
  if (!relevance) addCursorPredicate(where, binds, sort, decodeCursor(query.cursor), sortColumn);

  const rankBinds: unknown[] = [];
  const orderBy = relevance
    ? relevanceOrder(query.q, search.plan, rankBinds)
    : sortOrderBy(sort, sortColumn);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sortJoin = requestScopedSort ? requestScopedSortJoin(filter) : "";
  const sortSelect = requestScopedSort ? `, ${sortColumn} AS request_sort_value` : "";
  const sortJoinBinds = requestScopedSort ? filter.binds : [];

  let totalCount = null;
  if (query.includeTotal) {
    const countResult = await db
      .prepare(
        `SELECT COUNT(*) AS total FROM product_search_entities e${search.join} ${countWhere.length ? `WHERE ${countWhere.join(" AND ")}` : ""}`,
      )
      .bind(...countBinds)
      .all<{ total: number }>();
    totalCount = Number(countResult.results?.[0]?.total || 0);
  }

  // One extra row decides `hasMore` without a second count query.
  const paginationSql = query.offset > 0 ? "LIMIT ? OFFSET ?" : "LIMIT ?";
  const paginationBinds = query.offset > 0 ? [query.limit + 1, query.offset] : [query.limit + 1];
  const result = await db
    .prepare(
      `SELECT ${entityColumns("e")}${sortSelect} FROM product_search_entities e${search.join}${sortJoin} ${whereSql} ORDER BY ${orderBy} ${paginationSql}`,
    )
    .bind(...sortJoinBinds, ...binds, ...rankBinds, ...paginationBinds)
    .all<ProductSearchPageRow>();
  const rows = result.results || [];
  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const entityIds = pageRows.map((row) => Number(row.id));

  const [aggregates, representatives] = await Promise.all([
    loadOfferAggregates(db, entityIds, filter),
    loadRepresentativeOffers(db, entityIds, filter),
  ]);
  const now = Date.now();
  const items = pageRows.map((row) =>
    toProductSearchItem(row, {
      aggregate: aggregates.get(Number(row.id)) ?? null,
      representativeOffer: representatives.get(Number(row.id)) ?? null,
      now,
    }),
  );
  const last = pageRows.at(-1);
  const offerQueryChunkCount = chunked(entityIds).length;

  if (query.q) {
    console.log(
      JSON.stringify({
        event: "product_search",
        search_latency_ms: Date.now() - startedAt,
        search_result_count: items.length,
        search_term_count: search.plan?.terms.length || 0,
        search_fts_term_count: search.plan?.ftsTerms.length || 0,
        search_entity_total_count: totalCount,
        matched_catalog_entity_count: items.filter((item) => item.identity_kind === "catalog")
          .length,
        unresolved_fallback_entity_count: items.filter(
          (item) => item.identity_kind === "unresolved_listing",
        ).length,
        offer_summary_query_count: offerQueryChunkCount * (filter.active ? 2 : 1),
      }),
    );
  }

  return {
    items,
    hasMore,
    nextCursor:
      !relevance && hasMore && last
        ? cursorFor(last, sort, requestScopedSort ? (last.request_sort_value ?? null) : undefined)
        : null,
    ...(query.includeTotal
      ? { totalCount, totalPages: Math.ceil((totalCount ?? 0) / query.limit) }
      : {}),
  };
}

/**
 * One product and every eligible active offer beneath it.
 *
 * Unfiltered on purpose: the detail view is where a user compares shops, so it shows the whole
 * offer set rather than the subset that happened to satisfy the list request they arrived from.
 */
export async function productSearchDetail(
  db: QueryableDatabase,
  key: string,
): Promise<ProductSearchDetailResponse | null> {
  if (!parseProductSearchKey(key)) return null;
  const entity = await db
    .prepare(`SELECT ${entityColumns("e")} FROM product_search_entities e WHERE e.entity_key = ?`)
    .bind(key)
    .first<ProductSearchEntityRow>();
  if (!entity) return null;

  const offers = await db
    .prepare(`
      SELECT ${offerColumns("p")}
      FROM product_search_entity_offers m
      JOIN products p ON p.id = m.listing_product_id
      WHERE m.entity_id = ? AND p.is_active = 1
      ORDER BY ${REPRESENTATIVE_OFFER_ORDER}
      LIMIT ?
    `)
    .bind(Number(entity.id), MAX_DETAIL_OFFERS)
    .all<ProductSearchOfferRow>();
  const offerRows = offers.results || [];
  const product: ProductSearchItem = toProductSearchItem(entity, {
    representativeOffer: offerRows[0] ?? null,
  });
  return { product, offers: offerRows.map((row) => toProductOffer(row)) };
}