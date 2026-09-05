import { buildModelSearchAliases } from "../catalog/product-identity.js";
import {
  catalogModelLookupVariants,
  identitySafeModelLookupVariants,
} from "../catalog/knowledge-catalog.js";
import type { ReadableDatabase } from "./types.js";

export interface CatalogLookupInput {
  manufacturerId: string;
  model: string;
}
export interface CatalogLookupRow {
  id: number;
  manufacturer_id: string;
  canonical_model: string;
  normalized_model: string;
  canonical_name: string;
  category_id: string | null;
  is_primary: number | null;
}
export interface CatalogLookupAliasRow {
  product_id: number;
  alias: string;
  normalized_alias: string;
}

/** A coarse retrieval key, never proof of identity. Keep byte-equivalent to migration 0091's
 * expression indexes. The domain resolver still checks manufacturer, sale object and revisions. */
export function catalogRetrievalKeySql(column: string): string {
  const value = `UPPER(${column})`;
  const presentation = `(CASE WHEN SUBSTR(${value}, -3) IN ('/FB','/FN','-BK','-SP','-WH','(B)','(S)','(W)','(K)')
    THEN SUBSTR(${value},1,LENGTH(${value})-3)
    WHEN SUBSTR(${value}, -2) IN ('-K','-W') THEN SUBSTR(${value},1,LENGTH(${value})-2)
    ELSE ${value} END)`;
  return `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${presentation},' ',''),'-',''),'/',''),'.',''),'_','')`;
}

function retrievalKey(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/(?:\/F[BN]|-(?:BK|SP|WH|K|W)|\([BSWK]\))$/u, "")
    .replace(/[ \-/._]/gu, "");
}

function lookupKeys(input: CatalogLookupInput, purpose: "identity" | "category"): string[] {
  const variants =
    purpose === "identity"
      ? identitySafeModelLookupVariants(input)
      : catalogModelLookupVariants(input);
  return [
    ...new Set(
      variants
        .flatMap((model) => [model, ...buildModelSearchAliases(model)])
        .map(retrievalKey)
        .filter(Boolean),
    ),
  ];
}

/** Indexed exact/alias lookup shared by category enrichment and identity resolution. Candidate
 * multiplicity is preserved: no LIMIT 1 can turn an ambiguous key into an automatic match. */
export async function loadCatalogLookupCandidates(
  db: ReadableDatabase,
  inputs: readonly CatalogLookupInput[],
  purpose: "identity" | "category",
): Promise<{ rows: CatalogLookupRow[]; aliases: CatalogLookupAliasRow[] }> {
  const byManufacturer = new Map<string, Set<string>>();
  for (const input of inputs) {
    if (!input.manufacturerId || !input.model) continue;
    const keys = byManufacturer.get(input.manufacturerId) ?? new Set<string>();
    for (const key of lookupKeys(input, purpose)) keys.add(key);
    byManufacturer.set(input.manufacturerId, keys);
  }
  const ids = new Set<number>();
  for (const [manufacturer, keySet] of byManufacturer) {
    const keys = [...keySet];
    for (let i = 0; i < keys.length; i += 40) {
      const chunk = keys.slice(i, i + 40);
      const parameters = chunk.map(() => "?").join(",");
      const direct = await db
        .prepare(`SELECT kp.id FROM knowledge_catalog_products kp INDEXED BY idx_catalog_products_retrieval_key
        WHERE kp.verification_status = 'verified' AND kp.manufacturer_id = ?
          AND ${catalogRetrievalKeySql("kp.normalized_model")} IN (${parameters})`)
        .bind(manufacturer, ...chunk)
        .all<{ id: number }>();
      const alias = await db
        .prepare(`SELECT kp.id FROM knowledge_catalog_aliases ka INDEXED BY idx_catalog_aliases_retrieval_key
        CROSS JOIN knowledge_catalog_products kp ON kp.id = ka.product_id
        WHERE ka.alias_type = 'model' AND ${catalogRetrievalKeySql("ka.normalized_alias")} IN (${parameters})
          AND kp.verification_status = 'verified' AND kp.manufacturer_id = ?`)
        .bind(...chunk, manufacturer)
        .all<{ id: number }>();
      for (const row of [...(direct.results || []), ...(alias.results || [])])
        ids.add(Number(row.id));
    }
  }
  return loadCatalogRowsById(db, [...ids]);
}

export async function loadCatalogRowsById(
  db: ReadableDatabase,
  ids: readonly number[],
): Promise<{
  rows: CatalogLookupRow[];
  aliases: CatalogLookupAliasRow[];
}> {
  const rows: CatalogLookupRow[] = [];
  const aliases: CatalogLookupAliasRow[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const parameters = chunk.map(() => "?").join(",");
    const found = await db
      .prepare(`SELECT kp.id,kp.manufacturer_id,kp.canonical_model,kp.normalized_model,kp.canonical_name,
      kpc.category_id,kpc.is_primary FROM knowledge_catalog_products kp
      LEFT JOIN knowledge_catalog_product_categories kpc ON kpc.product_id = kp.id
      WHERE kp.verification_status = 'verified' AND kp.id IN (${parameters})
      ORDER BY kp.id,kpc.is_primary DESC,kpc.category_id`)
      .bind(...chunk)
      .all<CatalogLookupRow>();
    rows.push(...(found.results || []));
    const names = await db
      .prepare(`SELECT product_id,alias,normalized_alias FROM knowledge_catalog_aliases
      WHERE alias_type = 'model' AND product_id IN (${parameters})`)
      .bind(...chunk)
      .all<CatalogLookupAliasRow>();
    aliases.push(...(names.results || []));
  }
  return { rows, aliases };
}

/** Discovery is capped and cannot authorize exact or alias matches. */
export async function loadFuzzyCatalogCandidates(db: ReadableDatabase, input: CatalogLookupInput) {
  const key = lookupKeys(input, "identity")[0] || "";
  if (key.length < 8) return { rows: [], aliases: [] };
  const prefix = key.slice(0, 3);
  const result = await db
    .prepare(`SELECT kp.id FROM knowledge_catalog_products kp INDEXED BY idx_catalog_products_retrieval_key
    WHERE kp.verification_status = 'verified' AND kp.manufacturer_id = ?
      AND ${catalogRetrievalKeySql("kp.normalized_model")} >= ?
      AND ${catalogRetrievalKeySql("kp.normalized_model")} < ?
    ORDER BY ${catalogRetrievalKeySql("kp.normalized_model")} LIMIT 64`)
    .bind(input.manufacturerId, prefix, `${prefix}\uffff`)
    .all<{ id: number }>();
  return loadCatalogRowsById(
    db,
    (result.results || []).map((row) => row.id),
  );
}
