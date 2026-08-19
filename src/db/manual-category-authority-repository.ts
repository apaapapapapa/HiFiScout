import { knowledgeCatalogKey } from "../catalog/knowledge-catalog.js";
import type { KnowledgeCatalogMatch } from "../catalog/types.js";
import type { ReadableDatabase } from "./types.js";

const CHUNK_SIZE = 40;

interface ManualCategoryLookupProduct {
  manufacturerId?: string;
  manufacturer_id?: string;
  model?: string;
  modelResolutionStatus?: string;
  model_resolution_status?: string;
}

interface ManualCategoryCatalogRow {
  id: number;
  manufacturer_id: string;
  canonical_model: string;
  normalized_model: string;
  canonical_name: string;
  category_id: string;
}

interface ManualCategoryAliasRow {
  product_id: number;
  normalized_alias: string;
}

function unique(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function setUnambiguous(
  index: Map<string, KnowledgeCatalogMatch | null>,
  key: string,
  value: KnowledgeCatalogMatch,
): void {
  if (!key) return;
  if (!index.has(key)) {
    index.set(key, value);
    return;
  }
  const existing = index.get(key);
  if (!existing || existing.id !== value.id) index.set(key, null);
}

/**
 * Category-only authority for manually verified products whose seller model presentation remains a
 * Model Resolution candidate. The match surface is intentionally narrower than Product Identity:
 * only the exact catalog model or an explicit model alias may classify the listing. No derived or
 * fuzzy model normalization is accepted here, and this function never writes an identity match.
 */
export async function findManualVerifiedCategoryMatches(
  db: ReadableDatabase,
  products: readonly ManualCategoryLookupProduct[] = [],
): Promise<Map<string, KnowledgeCatalogMatch>> {
  const candidates = products.filter((product) => {
    const status = product.modelResolutionStatus || product.model_resolution_status || "";
    const manufacturerId = product.manufacturerId || product.manufacturer_id || "";
    return Boolean(status && status !== "resolved" && manufacturerId && product.model);
  });
  if (!candidates.length) return new Map();

  const manufacturerIds = unique(
    candidates.map((product) => product.manufacturerId || product.manufacturer_id),
  ).map((value) => value.toLowerCase());

  const catalogRows: ManualCategoryCatalogRow[] = [];
  for (let i = 0; i < manufacturerIds.length; i += CHUNK_SIZE) {
    const chunk = manufacturerIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT DISTINCT kp.id, kp.manufacturer_id, kp.canonical_model, kp.normalized_model,
               kp.canonical_name, kpc.category_id
        FROM knowledge_catalog_products kp
        JOIN knowledge_catalog_sources s
          ON s.product_id = kp.id
         AND s.source_type = 'manual_verified'
         AND s.status = 'active'
        JOIN knowledge_catalog_product_categories kpc
          ON kpc.product_id = kp.id AND kpc.is_primary = 1
        WHERE kp.verification_status = 'verified'
          AND kp.manufacturer_id IN (${placeholders})
        ORDER BY kp.id
      `)
      .bind(...chunk)
      .all<ManualCategoryCatalogRow>();
    catalogRows.push(...(result.results || []));
  }

  const aliasesByProduct = new Map<number, string[]>();
  const productIds = catalogRows.map((row) => row.id);
  for (let i = 0; i < productIds.length; i += CHUNK_SIZE) {
    const chunk = productIds.slice(i, i + CHUNK_SIZE);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT product_id, normalized_alias
        FROM knowledge_catalog_aliases
        WHERE alias_type = 'model' AND product_id IN (${placeholders})
      `)
      .bind(...chunk)
      .all<ManualCategoryAliasRow>();
    for (const row of result.results || []) {
      const aliases = aliasesByProduct.get(row.product_id) || [];
      aliases.push(row.normalized_alias);
      aliasesByProduct.set(row.product_id, aliases);
    }
  }

  const index = new Map<string, KnowledgeCatalogMatch | null>();
  for (const row of catalogRows) {
    const base = {
      id: row.id,
      manufacturerId: row.manufacturer_id,
      canonicalModel: row.canonical_model,
      normalizedModel: row.normalized_model,
      canonicalName: row.canonical_name,
      categoryIds: [row.category_id],
    };
    setUnambiguous(index, knowledgeCatalogKey(row.manufacturer_id, row.normalized_model), {
      ...base,
      matchType: "exact",
    });
    for (const alias of aliasesByProduct.get(row.id) || []) {
      setUnambiguous(index, knowledgeCatalogKey(row.manufacturer_id, alias), {
        ...base,
        matchType: "alias",
      });
    }
  }

  const matches = new Map<string, KnowledgeCatalogMatch>();
  for (const product of candidates) {
    const key = knowledgeCatalogKey(
      product.manufacturerId || product.manufacturer_id,
      product.model,
    );
    const match = key ? index.get(key) : null;
    if (key && match) matches.set(key, match);
  }
  return matches;
}
