import { parseCatalogPhoto, parseCatalogPhotoUpdate } from "../api/catalog-photo-contracts.js";
import type { CatalogPhoto, CatalogPhotoSnapshot } from "../api/catalog-photo-contracts.js";
import type { QueryableDatabase } from "./types.js";
import { firstMeasured } from "./read-accounting.js";

export function decodeCatalogPhoto(value: unknown): CatalogPhoto | null {
  if (typeof value !== "string") return null;
  try {
    return parseCatalogPhoto(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Correlated primary-key lookup: no scan or separate query per result, even as the catalog grows. */
export function catalogPhotoColumn(productId: string): string {
  return `(SELECT photo_json FROM catalog_product_photos WHERE catalog_product_id = ${productId}) AS catalog_photo_json`;
}

export async function readCatalogPhoto(
  db: QueryableDatabase,
  id: number,
): Promise<CatalogPhotoSnapshot | null> {
  const row = await firstMeasured<{
    id: number;
    photo_json: string | null;
    revision: number | null;
  }>(
    db
      .prepare(`SELECT p.id, i.photo_json, i.revision FROM knowledge_catalog_products p
      LEFT JOIN catalog_product_photos i ON i.catalog_product_id = p.id WHERE p.id = ?`)
      .bind(id),
  );
  return row
    ? { productId: id, photo: decodeCatalogPhoto(row.photo_json), revision: row.revision ?? 0 }
    : null;
}

export async function updateCatalogPhoto(
  db: QueryableDatabase,
  id: number,
  input: unknown,
): Promise<CatalogPhotoSnapshot | null> {
  const parsed = parseCatalogPhotoUpdate(input);
  if (!parsed || !Number.isSafeInteger(id) || id <= 0) throw new Error("invalid_catalog_photo");
  const existing = await readCatalogPhoto(db, id);
  if (!existing) return null;
  if (JSON.stringify(existing.photo) === JSON.stringify(parsed.photo)) return existing;
  if (existing.revision !== parsed.expectedRevision) throw new Error("catalog_photo_conflict");
  const json = parsed.photo ? JSON.stringify(parsed.photo) : null;
  const result = await db
    .prepare(`INSERT INTO catalog_product_photos (catalog_product_id, photo_json, revision, updated_at)
    SELECT ?, ?, 1, ? WHERE ? = 0 OR EXISTS (
      SELECT 1 FROM catalog_product_photos WHERE catalog_product_id = ? AND revision = ?)
    ON CONFLICT(catalog_product_id) DO UPDATE SET photo_json = excluded.photo_json,
      revision = catalog_product_photos.revision + 1, updated_at = excluded.updated_at
    WHERE catalog_product_photos.revision = ? AND catalog_product_photos.photo_json IS NOT excluded.photo_json`)
    .bind(
      id,
      json,
      new Date().toISOString(),
      parsed.expectedRevision,
      id,
      parsed.expectedRevision,
      parsed.expectedRevision,
    )
    .run();
  if (result.meta?.changes !== 1) throw new Error("catalog_photo_conflict");
  return readCatalogPhoto(db, id);
}
