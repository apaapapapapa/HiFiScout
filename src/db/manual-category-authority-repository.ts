import { knowledgeCatalogKey, normalizeCatalogModel } from "../catalog/knowledge-catalog.js";
import type { KnowledgeCatalogMatch } from "../catalog/types.js";
import { catalogRetrievalKey, catalogRetrievalKeySql } from "./catalog-lookup-candidates.js";
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
  lookup_model: string;
  match_type: "exact" | "alias";
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

  const requested = unique(
    candidates.map((product) => {
      const manufacturerId = String(
        product.manufacturerId || product.manufacturer_id || "",
      ).toLowerCase();
      const model = normalizeCatalogModel(product.model || "");
      return manufacturerId && model ? JSON.stringify([manufacturerId, model]) : "";
    }),
  ).map((value) => JSON.parse(value) as [string, string]);
  const requestedKeys = new Set(
    requested.map(([manufacturerId, model]) => `${manufacturerId}:${model}`),
  );

  const catalogRows: ManualCategoryCatalogRow[] = [];
  for (let i = 0; i < requested.length; i += CHUNK_SIZE) {
    const chunk = requested.slice(i, i + CHUNK_SIZE);
    // Anchor each pair through the existing coarse retrieval index before applying exact equality.
    // The retrieval key only narrows candidates; it never broadens manual authority semantics.
    const wanted = JSON.stringify(
      chunk.map(([manufacturerId, model]) => [manufacturerId, model, catalogRetrievalKey(model)]),
    );
    const [exact, aliases] = await Promise.all([
      db
        .prepare(`
          SELECT kp.id, kp.manufacturer_id, kp.canonical_model, kp.normalized_model,
                 kp.canonical_name, kpc.category_id,
                 kp.normalized_model AS lookup_model, 'exact' AS match_type
          FROM json_each(?) wanted
          CROSS JOIN knowledge_catalog_products kp INDEXED BY idx_catalog_products_retrieval_key
          CROSS JOIN knowledge_catalog_product_categories kpc
            ON kpc.product_id = kp.id AND kpc.is_primary = 1
          WHERE kp.verification_status = 'verified'
            AND kp.manufacturer_id = json_extract(wanted.value, '$[0]')
            AND ${catalogRetrievalKeySql("kp.normalized_model")} = json_extract(wanted.value, '$[2]')
            AND kp.normalized_model = json_extract(wanted.value, '$[1]')
            AND EXISTS (
              SELECT 1 FROM knowledge_catalog_sources s
              WHERE s.product_id = kp.id
                AND s.source_type = 'manual_verified'
                AND s.status = 'active'
            )
        `)
        .bind(wanted)
        .all<ManualCategoryCatalogRow>(),
      db
        .prepare(`
          SELECT kp.id, kp.manufacturer_id, kp.canonical_model, kp.normalized_model,
                 kp.canonical_name, kpc.category_id,
                 ka.normalized_alias AS lookup_model, 'alias' AS match_type
          FROM json_each(?) wanted
          CROSS JOIN knowledge_catalog_aliases ka INDEXED BY idx_knowledge_catalog_aliases_lookup
          CROSS JOIN knowledge_catalog_products kp ON kp.id = ka.product_id
          CROSS JOIN knowledge_catalog_product_categories kpc
            ON kpc.product_id = kp.id AND kpc.is_primary = 1
          WHERE ka.alias_type = 'model'
            AND ka.normalized_alias = json_extract(wanted.value, '$[1]')
            AND kp.verification_status = 'verified'
            AND kp.manufacturer_id = json_extract(wanted.value, '$[0]')
            AND EXISTS (
              SELECT 1 FROM knowledge_catalog_sources s
              WHERE s.product_id = kp.id
                AND s.source_type = 'manual_verified'
                AND s.status = 'active'
            )
        `)
        .bind(wanted)
        .all<ManualCategoryCatalogRow>(),
    ]);
    catalogRows.push(...(exact.results || []), ...(aliases.results || []));
  }

  const index = new Map<string, KnowledgeCatalogMatch | null>();
  for (const row of catalogRows) {
    const key = knowledgeCatalogKey(row.manufacturer_id, row.lookup_model);
    if (!requestedKeys.has(key)) continue;
    setUnambiguous(index, key, {
      id: row.id,
      manufacturerId: row.manufacturer_id,
      canonicalModel: row.canonical_model,
      normalizedModel: row.normalized_model,
      canonicalName: row.canonical_name,
      categoryIds: [row.category_id],
      matchType: row.match_type,
    });
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
