/**
 * The one production implementation of `/api/products` list search.
 *
 * Free-text matching runs against `product_search_projection` (+ its FTS5 index) rather than the
 * listing columns, so relevance and filtering stay independent of how a shop happened to spell a
 * title. The caller supplies an already-normalized {@link ProductQuery}; this module owns SQL,
 * not query-string parsing.
 */

import { categoryIdForFilter } from "../catalog/categories.js";
import { normalizeIdentityModel } from "../catalog/product-identity.js";
import { manufacturerIdForFilter, splitKnownManufacturerModel } from "../catalog/manufacturers.js";
import { parseFtsSearchQuery } from "../search/fts-query.js";
import type { FtsSearchPlan } from "../search/fts-query.js";
import { usesRelevanceOrder } from "../api/product-query.js";
import type { ProductQuery } from "../api/product-query.js";
import type { ProductListResponse } from "../api/contracts.js";
import {
  addCursorPredicate,
  cursorFor,
  decodeCursor,
  sortDefinition,
  sortOrderBy,
} from "./product-list-cursor.js";
import { productColumns, toProductListItem } from "./product-row-mapper.js";
import type { ProductRow, QueryableDatabase } from "./types.js";

interface SearchPlanResult {
  join: string;
  plan: FtsSearchPlan | null;
}

/**
 * Joins the search projection and adds the matching predicates.
 *
 * Terms of three or more code points go through FTS5; shorter ones (`SE`, `MC`) are too small for
 * the tokenizer and fall back to bounded LIKE scans over the same projection columns.
 */
function addSearchPlan(q: string, where: string[], binds: unknown[]): SearchPlanResult {
  if (!q) return { join: "", plan: null };
  const plan = parseFtsSearchQuery(q);
  let join = "JOIN product_search_projection sp ON sp.product_id = p.id";
  if (plan.ftsQuery) {
    join += " JOIN product_search_fts ON product_search_fts.rowid = sp.product_id";
    where.push("product_search_fts MATCH ?");
    binds.push(plan.ftsQuery);
  }
  for (const value of plan.shortTerms) {
    const term = `%${value}%`;
    where.push(`(
      sp.manufacturer_terms LIKE ? OR sp.normalized_model LIKE ? OR sp.model_terms LIKE ?
      OR sp.title LIKE ? OR sp.category_terms LIKE ?
    )`);
    binds.push(term, term, term, term, term);
  }
  return { join, plan };
}

/** Exact manufacturer+model beats exact model, which beats an exact title, then bm25. */
function relevanceOrder(q: string, plan: FtsSearchPlan | null, rankBinds: unknown[]): string {
  const known = splitKnownManufacturerModel(q);
  const queryModel = known?.model || q;
  const normalizedModel = normalizeIdentityModel(queryModel);
  const cases = [];
  if (known?.id && normalizedModel) {
    cases.push("WHEN sp.manufacturer_id = ? AND sp.normalized_model = ? THEN 0");
    rankBinds.push(known.id, normalizedModel);
  }
  if (normalizedModel) {
    cases.push("WHEN sp.normalized_model = ? THEN 1");
    rankBinds.push(normalizedModel);
  }
  cases.push("WHEN LOWER(sp.title) = LOWER(?) THEN 2");
  rankBinds.push(q);
  const caseSql = `CASE ${cases.join(" ")} ELSE 3 END ASC`;
  const ftsRank = plan?.ftsQuery ? ", bm25(product_search_fts, 8.0, 7.0, 6.0, 4.0, 1.0) ASC" : "";
  return `${caseSql}${ftsRank}, p.last_activity_at DESC, p.id DESC`;
}

function addFilters(query: ProductQuery, where: string[], binds: unknown[]): void {
  if (query.shop) {
    where.push("p.shop_key = ?");
    binds.push(query.shop);
  }
  if (query.manufacturer) {
    where.push("(p.manufacturer_id = ? OR p.manufacturer = ?)");
    binds.push(manufacturerIdForFilter(query.manufacturer), query.manufacturer);
  }
  if (query.category) {
    const categoryId = categoryIdForFilter(query.category);
    if (categoryId) {
      // Closure table: a group category matches every descendant leaf.
      where.push(
        "EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ?)",
      );
      binds.push(categoryId);
    } else {
      where.push("p.category = ?");
      binds.push(query.category);
    }
  }
  for (const feature of query.features) {
    where.push(
      "EXISTS (SELECT 1 FROM product_feature_facts pff WHERE pff.product_id = p.id AND pff.feature_id = ? AND pff.state = 'present')",
    );
    binds.push(feature);
  }
  if (query.inStock) where.push("p.stock_status = 'in_stock'");
  if (query.newOnly) {
    where.push(
      "COALESCE(p.source_published_at, p.first_seen_at) >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-48 hours')",
    );
  }
  if (query.priceDropped) {
    where.push(
      "(p.previous_price_yen IS NOT NULL AND p.price_yen IS NOT NULL AND p.price_yen < p.previous_price_yen)",
    );
  }
  if (query.minPrice != null) {
    where.push("p.price_yen >= ?");
    binds.push(query.minPrice);
  }
  if (query.maxPrice != null) {
    where.push("p.price_yen <= ?");
    binds.push(query.maxPrice);
  }
}

export async function listProducts(
  db: QueryableDatabase,
  query: ProductQuery,
): Promise<ProductListResponse> {
  const startedAt = Date.now();
  const where: string[] = ["p.is_active = 1"];
  const binds: unknown[] = [];
  const search = addSearchPlan(query.q, where, binds);
  addFilters(query, where, binds);

  // Snapshot before the cursor predicate: the total must count the whole result set.
  const countWhere = [...where];
  const countBinds = [...binds];
  const relevance = usesRelevanceOrder(query);
  const sort = sortDefinition(query.sort);
  if (!relevance) addCursorPredicate(where, binds, sort, decodeCursor(query.cursor));

  const rankBinds: unknown[] = [];
  const orderBy = relevance ? relevanceOrder(query.q, search.plan, rankBinds) : sortOrderBy(sort);

  let totalCount = null;
  if (query.includeTotal) {
    const countResult = await db
      .prepare(
        `SELECT COUNT(*) AS total FROM products p ${search.join} WHERE ${countWhere.join(" AND ")}`,
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
      `SELECT ${productColumns("p")} FROM products p ${search.join} WHERE ${where.join(" AND ")} ORDER BY ${orderBy} ${paginationSql}`,
    )
    .bind(...binds, ...rankBinds, ...paginationBinds)
    .all<ProductRow>();
  const rows = result.results || [];
  const hasMore = rows.length > query.limit;
  const items = (hasMore ? rows.slice(0, query.limit) : rows).map((row) => toProductListItem(row));
  const last = items.at(-1);

  if (query.q) {
    console.log(
      JSON.stringify({
        event: "product_search",
        search_latency_ms: Date.now() - startedAt,
        search_result_count: items.length,
        search_term_count: search.plan?.terms.length || 0,
        search_fts_term_count: search.plan?.ftsTerms.length || 0,
      }),
    );
  }

  return {
    items,
    hasMore,
    nextCursor: !relevance && hasMore && last ? cursorFor(last, sort) : null,
    ...(query.includeTotal
      ? { totalCount, totalPages: Math.ceil((totalCount ?? 0) / query.limit) }
      : {}),
  };
}
