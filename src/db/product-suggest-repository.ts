/** Bounded typeahead suggestions derived only from the product-search entity read model. */

import { normalizeManufacturer, splitKnownManufacturerModel } from "../catalog/manufacturers.js";
import { normalizeIdentityModel } from "../catalog/product-identity.js";
import { MAX_SUGGESTIONS, MIN_SUGGEST_QUERY_LENGTH } from "../api/contracts.js";
import { parseFtsSearchQuery, quoteFtsTerm } from "../search/fts-query.js";
import type { FtsSearchPlan } from "../search/fts-query.js";
import type { QueryableDatabase } from "./types.js";

const MAX_SUGGEST_CANDIDATES = 24;

interface ProductSuggestRow {
  id: number;
  manufacturer_id: string;
  manufacturer: string;
  model: string;
  normalized_model: string;
}

const SUGGEST_COLUMNS = "e.id, e.manufacturer_id, e.manufacturer, e.model, e.normalized_model";

function escapedLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function normalizedModelQuery(q: string): string {
  const split = splitKnownManufacturerModel(q);
  return normalizeIdentityModel(split?.model || q);
}

function ftsSuggestionQuery(plan: FtsSearchPlan, normalizedModel: string): string {
  const clauses: string[] = [];
  if (plan.ftsQuery) clauses.push(`(${plan.ftsQuery})`);
  if ([...normalizedModel].length >= MIN_SUGGEST_QUERY_LENGTH) {
    clauses.push(`normalized_model : ${quoteFtsTerm(normalizedModel)}`);
  }
  return clauses.join(" OR ");
}

/**
 * Short terms cannot use the trigram index, but mixed queries can still apply them after FTS has
 * narrowed the candidate set. This mirrors product search rather than silently dropping `14` from
 * a query such as `Marantz 14`.
 */
function addShortTermPredicates(plan: FtsSearchPlan, where: string[], binds: unknown[]): void {
  for (const value of plan.shortTerms) {
    const term = `%${escapedLike(value)}%`;
    where.push(`(
      e.manufacturer_terms LIKE ? ESCAPE '\\'
      OR e.normalized_model LIKE ? ESCAPE '\\'
      OR e.model_terms LIKE ? ESCAPE '\\'
      OR e.title_terms LIKE ? ESCAPE '\\'
      OR e.category_terms LIKE ? ESCAPE '\\'
    )`);
    binds.push(term, term, term, term, term);
  }
}

async function loadCandidates(
  db: QueryableDatabase,
  q: string,
  normalizedModel: string,
): Promise<ProductSuggestRow[]> {
  const plan = parseFtsSearchQuery(q);
  const ftsQuery = ftsSuggestionQuery(plan, normalizedModel);
  if (!ftsQuery) return [];

  const knownManufacturerId = splitKnownManufacturerModel(q)?.id || "";
  const exactOrder = normalizedModel
    ? `CASE
        WHEN e.normalized_model = ? THEN 0
        WHEN e.normalized_model LIKE ? ESCAPE '\\' THEN 1
        ELSE 2
      END,
      CASE WHEN ? <> '' AND e.manufacturer_id = ? THEN 0 ELSE 1 END,`
    : "";
  const orderBinds = normalizedModel
    ? [
        normalizedModel,
        `${escapedLike(normalizedModel)}%`,
        knownManufacturerId,
        knownManufacturerId,
      ]
    : [];
  const where = ["product_search_entities_fts MATCH ?"];
  const whereBinds: unknown[] = [ftsQuery];
  addShortTermPredicates(plan, where, whereBinds);

  const result = await db
    .prepare(`
      SELECT ${SUGGEST_COLUMNS}
      FROM product_search_entities e
      JOIN product_search_entities_fts ON product_search_entities_fts.rowid = e.id
      WHERE ${where.join(" AND ")}
      ORDER BY ${exactOrder} bm25(product_search_entities_fts), e.id
      LIMIT ?
    `)
    .bind(...whereBinds, ...orderBinds, MAX_SUGGEST_CANDIDATES)
    .all<ProductSuggestRow>();
  return result.results || [];
}

function canonicalManufacturer(row: ProductSuggestRow): string {
  return normalizeManufacturer(row.manufacturer || row.manufacturer_id).displayName;
}

function suggestionKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * Return canonical manufacturer and manufacturer+model completions, de-duplicated and capped.
 *
 * One- and two-code-point whole queries intentionally return no suggestions: FTS5's trigram index
 * cannot serve them, and a leading-wildcard LIKE would scan the entire public read model for every
 * first keystroke. Mixed queries remain supported because short sub-terms are applied after FTS.
 *
 * Model matches are emitted before their manufacturer so model-number typeahead does not fill the
 * small response window with repeated brand-only values. Manufacturer searches do the inverse.
 */
export async function suggestProducts(db: QueryableDatabase, q: string): Promise<string[]> {
  if ([...q].length < MIN_SUGGEST_QUERY_LENGTH) return [];
  const normalizedModel = normalizedModelQuery(q);
  const rows = await loadCandidates(db, q, normalizedModel);
  const suggestions: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const manufacturer = canonicalManufacturer(row);
    const model = row.model.trim();
    const combined = [manufacturer, model].filter(Boolean).join(" ");
    const modelMatch = Boolean(
      normalizedModel && row.normalized_model && row.normalized_model.includes(normalizedModel),
    );
    const candidates = modelMatch ? [combined, manufacturer] : [manufacturer, combined];

    for (const candidate of candidates) {
      if (!candidate) continue;
      const key = suggestionKey(candidate);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      suggestions.push(candidate);
      if (suggestions.length >= MAX_SUGGESTIONS) return suggestions;
    }
  }

  return suggestions;
}
