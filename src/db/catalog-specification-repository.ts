import { parseCatalogSpecifications } from "../api/catalog-specification-contracts.js";
import type { CatalogSpecificationRecord } from "../api/catalog-specification-contracts.js";
import type { QueryableDatabase } from "./types.js";
import { firstMeasured } from "./read-accounting.js";

export function decodeCatalogSpecifications(
  json: unknown,
  updatedAt: unknown,
): CatalogSpecificationRecord | null {
  if (
    typeof json !== "string" ||
    typeof updatedAt !== "string" ||
    !Number.isFinite(Date.parse(updatedAt))
  )
    return null;
  try {
    const value = parseCatalogSpecifications(JSON.parse(json));
    return value ? { ...value, updatedAt } : null;
  } catch {
    return null;
  }
}

export async function readCatalogSpecifications(db: QueryableDatabase, id: number) {
  const row = await firstMeasured<{ id: number; specification_json: string | null; updated_at: string | null }>(db
    .prepare(`SELECT kp.id, s.specification_json, s.updated_at
    FROM knowledge_catalog_products kp LEFT JOIN catalog_product_specifications s
      ON s.catalog_product_id = kp.id WHERE kp.id = ?`)
    .bind(id));
  return row
    ? {
        productId: id,
        specifications: decodeCatalogSpecifications(row.specification_json, row.updated_at),
      }
    : null;
}

export async function updateCatalogSpecifications(
  db: QueryableDatabase,
  id: number,
  input: unknown,
) {
  const parsed = parseCatalogSpecifications(input);
  if (!parsed || !Number.isSafeInteger(id) || id <= 0)
    throw new Error("invalid_catalog_specifications");
  const existing = await readCatalogSpecifications(db, id);
  if (!existing) return null;
  const json = JSON.stringify(parsed);
  await db
    .prepare(`INSERT INTO catalog_product_specifications (catalog_product_id, specification_json, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(catalog_product_id) DO UPDATE SET
      specification_json = excluded.specification_json, updated_at = excluded.updated_at
    WHERE catalog_product_specifications.specification_json != excluded.specification_json`)
    .bind(id, json, new Date().toISOString())
    .run();
  return readCatalogSpecifications(db, id);
}
