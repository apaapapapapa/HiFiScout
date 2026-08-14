import { buildModelSearchAliases, normalizeIdentityModel } from "../catalog/product-identity.js";
import { manufacturerSearchAliases } from "../catalog/manufacturers.js";
import type {
  ProductRow,
  ProductSearchProjection,
  ProductSearchProjectionInput,
  ProductSearchProjectionRow,
  ProjectionSyncResult,
  QueryableDatabase,
} from "./types.js";

const CHUNK_SIZE = 50;

type ProjectionSourceRow = Pick<
  ProductRow,
  | "id"
  | "manufacturer_id"
  | "manufacturer"
  | "raw_manufacturer"
  | "model"
  | "title"
  | "category"
  | "raw_category"
  | "search_aliases"
>;

function uniqueText(values: readonly unknown[] = []): string[] {
  return [
    ...new Set(
      values
        .map((value) =>
          String(value || "")
            .normalize("NFKC")
            .trim(),
        )
        .filter(Boolean),
    ),
  ];
}

export function buildProductSearchProjection(
  product: ProductSearchProjectionInput = {},
): ProductSearchProjection {
  const manufacturerId = product.manufacturer_id || product.manufacturerId || "";
  const model = product.model || "";
  return {
    productId: Number(product.id),
    manufacturerId,
    sourceModel: model,
    normalizedModel: normalizeIdentityModel(model),
    manufacturerTerms: uniqueText([
      manufacturerId,
      product.manufacturer,
      product.raw_manufacturer || product.rawManufacturer,
      ...manufacturerSearchAliases(manufacturerId || product.manufacturer),
    ]).join(" "),
    modelTerms: uniqueText([model, ...buildModelSearchAliases(model)]).join(" "),
    title: String(product.title || "")
      .normalize("NFKC")
      .trim(),
    categoryTerms: uniqueText([
      product.category,
      product.raw_category || product.rawCategory,
      product.search_aliases || product.searchAliases,
    ]).join(" "),
  };
}

function sameProjection(
  row: ProductSearchProjectionRow | undefined,
  projection: ProductSearchProjection,
): boolean {
  return Boolean(
    row &&
    row.manufacturer_id === projection.manufacturerId &&
    row.source_model === projection.sourceModel &&
    row.normalized_model === projection.normalizedModel &&
    row.manufacturer_terms === projection.manufacturerTerms &&
    row.model_terms === projection.modelTerms &&
    row.title === projection.title &&
    row.category_terms === projection.categoryTerms,
  );
}

async function loadRowsForSources(
  db: QueryableDatabase,
  shopKey: string,
  sourceIds: readonly string[],
): Promise<ProjectionSourceRow[]> {
  const rows: ProjectionSourceRow[] = [];
  const ids = [...new Set(sourceIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT id, manufacturer_id, manufacturer, raw_manufacturer, model, title,
               category, raw_category, search_aliases
        FROM products
        WHERE shop_key = ? AND source_id IN (${placeholders})
      `)
      .bind(shopKey, ...chunk)
      .all<ProjectionSourceRow>();
    rows.push(...(result.results || []));
  }
  return rows;
}

async function loadExistingProjections(
  db: QueryableDatabase,
  productIds: readonly number[],
): Promise<Map<number, ProductSearchProjectionRow>> {
  const rows: ProductSearchProjectionRow[] = [];
  for (let i = 0; i < productIds.length; i += CHUNK_SIZE) {
    const chunk = productIds.slice(i, i + CHUNK_SIZE);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT product_id, manufacturer_id, source_model, normalized_model, manufacturer_terms, model_terms, title, category_terms
        FROM product_search_projection
        WHERE product_id IN (${placeholders})
      `)
      .bind(...chunk)
      .all<ProductSearchProjectionRow>();
    rows.push(...(result.results || []));
  }
  return new Map(rows.map((row) => [Number(row.product_id), row]));
}

export async function syncProductSearchProjections(
  db: QueryableDatabase,
  shopKey: string,
  sourceIds: readonly string[] = [],
): Promise<ProjectionSyncResult> {
  const rows = await loadRowsForSources(db, shopKey, sourceIds);
  if (!rows.length) return { checkedCount: 0, changedCount: 0 };

  const projections = rows.map(buildProductSearchProjection);
  const existing = await loadExistingProjections(
    db,
    projections.map((projection) => projection.productId),
  );
  const statements: D1PreparedStatement[] = [];
  for (const projection of projections) {
    if (sameProjection(existing.get(projection.productId), projection)) continue;
    statements.push(
      db
        .prepare(`
          INSERT INTO product_search_projection(
            product_id, manufacturer_id, source_model, normalized_model, manufacturer_terms, model_terms, title, category_terms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(product_id) DO UPDATE SET
            manufacturer_id = excluded.manufacturer_id,
            source_model = excluded.source_model,
            normalized_model = excluded.normalized_model,
            manufacturer_terms = excluded.manufacturer_terms,
            model_terms = excluded.model_terms,
            title = excluded.title,
            category_terms = excluded.category_terms
        `)
        .bind(
          projection.productId,
          projection.manufacturerId,
          projection.sourceModel,
          projection.normalizedModel,
          projection.manufacturerTerms,
          projection.modelTerms,
          projection.title,
          projection.categoryTerms,
        ),
    );
  }

  for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
    await db.batch(statements.slice(i, i + CHUNK_SIZE));
  }
  return { checkedCount: rows.length, changedCount: statements.length };
}
