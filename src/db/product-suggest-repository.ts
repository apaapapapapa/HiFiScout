/** Bounded typeahead suggestions derived only from the product-search entity read model. */

import { normalizeManufacturer, splitKnownManufacturerModel } from "../catalog/manufacturers.js";
import { normalizeIdentityModel } from "../catalog/product-identity.js";
import { parseFtsSearchQuery, quoteFtsTerm } from "../search/fts-query.js";
import type { QueryableDatabase } from "./types.js";

/** Public response ceiling. The database candidate window is separately bounded below. */
export const MAX_SUGGESTIONS = 8;
const MAX_SUGGEST_CANDIDATES = 24;

interface ProductSuggestRow {
  id: number;
  manufacturer_id: string;
  manufacturer: string;
  model: string;
  normalized_model: string;
}

const SUGGEST_COLUMNS =
  "e.id, e.manufacturer_id, e.manufacturer, e.model, e.normalized_model";

function escapedLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function normalizedModelQuery(q: string): string {
  const split = splitKnownManufacturerModel(q);
  return normalizeIdentityModel(split?.model || q);
}

function ftsSuggestionQuery(q: string, normalizedModel: string): string {
  const plan = parseFtsSearchQuery(q);
  const clauses: string[] = [];
  if (plan.ftsQuery) clauses.push(`(${plan.ftsQuery})`);
  if ([...normalizedModel].length >= 3) {
    clauses.push(`normalized_model : ${quoteFtsTerm(normalizedModel)}`);
  }
  return clauses.join(" OR ");
}

async function loadCandidates(
  db: QueryableDatabase,
  q: string,
  normalizedModel: string,
): Promise<ProductSuggestRow[]> {
  const ftsQuery = ftsSuggestionQuery(q, normalizedModel);
  const knownManufacturerId = splitKnownManufacturerModel(q)?.id || "";

  if (ftsQuery) {
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
    const result = await db
      .prepare(`
        SELECT ${SUGGEST_COLUMNS}
        FROM product_search_entities e
        JOIN product_search_entities_fts ON product_search_entities_fts.rowid = e.id
        WHERE product_search_entities_fts MATCH ?
        ORDER BY ${exactOrder} bm25(product_search_entities_fts), e.id
        LIMIT ?
      `)
      .bind(ftsQuery, ...orderBinds, MAX_SUGGEST_CANDIDATES)
      .all<ProductSuggestRow>();
    return result.results || [];
  }

  // One- and two-code-point input is too short for the trigram tokenizer. Keep the fallback scan
  // bounded by the same candidate limit and restricted to the three entity search columns.
  const term = `%${escapedLike(q)}%`;
  const normalizedTerm = normalizedModel ? `%${escapedLike(normalizedModel)}%` : term;
  const result = await db
    .prepare(`
      SELECT ${SUGGEST_COLUMNS}
      FROM product_search_entities e
      WHERE e.manufacturer_terms LIKE ? ESCAPE '\\'
         OR e.model_terms LIKE ? ESCAPE '\\'
         OR e.normalized_model LIKE ? ESCAPE '\\'
      ORDER BY e.manufacturer_id COLLATE NOCASE, e.normalized_model COLLATE NOCASE, e.id
      LIMIT ?
    `)
    .bind(term, term, normalizedTerm, MAX_SUGGEST_CANDIDATES)
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
 * Model matches are emitted before their manufacturer so model-number typeahead does not fill the
 * small response window with repeated brand-only values. Manufacturer searches do the inverse.
 */
export async function suggestProducts(db: QueryableDatabase, q: string): Promise<string[]> {
  if (!q) return [];
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
