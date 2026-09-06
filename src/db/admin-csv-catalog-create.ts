import type { AdminCsvApplyInput, AdminCsvValues } from "../api/admin-csv-contracts.js";
import { normalizeCatalogModel } from "../catalog/knowledge-catalog.js";
import {
  catalogIdentityKey,
  catalogIdentityManufacturerIds,
} from "../catalog/knowledge-catalog-identity.js";
import {
  catalogIdentityBucketKey,
  catalogIdentityBucketKeySql,
} from "./knowledge-catalog-identity.js";
import { catalogAdminCategoryIds } from "./knowledge-catalog-admin-repository.js";
import { catalogCsvManufacturerStatements } from "./admin-csv-catalog-manufacturer.js";
import { firstMeasured } from "./read-accounting.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";

// No listing counts or whole-manufacturer scans. The expression index also covers rejected rows.
// Retain the bounded bucket snapshot so a concurrent logical duplicate aborts the entire insert.
const BUCKET_SQL = `SELECT json_group_array(json_array(id, manufacturer_id, canonical_model, normalized_model))
  FROM (SELECT id, manufacturer_id, canonical_model, normalized_model
    FROM knowledge_catalog_products
    WHERE manufacturer_id IN (SELECT value FROM json_each(?))
      AND ${catalogIdentityBucketKeySql("normalized_model")} = ?
    ORDER BY manufacturer_id, id LIMIT 51)`;

function bucketParameters(values: AdminCsvValues): [string, string] {
  return [
    JSON.stringify(catalogIdentityManufacturerIds(values.manufacturer_id)),
    catalogIdentityBucketKey(normalizeCatalogModel(values.canonical_model)),
  ];
}

export async function loadCatalogCsvCreation(db: ReadableDatabase, values: AdminCsvValues) {
  const row = await firstMeasured<{ snapshot: string }>(
    db.prepare(`SELECT (${BUCKET_SQL}) AS snapshot`).bind(...bucketParameters(values)),
  );
  const snapshot = row?.snapshot || "[]";
  const candidates = JSON.parse(snapshot) as [number, string, string, string][];
  const identity = catalogIdentityKey(values.manufacturer_id, values.canonical_model);
  return {
    snapshot,
    overflow: candidates.length >= 51,
    ids: candidates
      .filter(
        ([, manufacturer, model, normalized]) =>
          catalogIdentityKey(manufacturer, model) === identity ||
          (manufacturer === values.manufacturer_id &&
            normalized === normalizeCatalogModel(values.canonical_model)),
      )
      .map(([id]) => id),
  };
}

export function catalogCsvCreationRevision(values: AdminCsvValues, snapshot: string): string {
  return JSON.stringify({ create: values, snapshot });
}

export async function createCatalogCsvProduct(
  db: QueryableDatabase,
  input: AdminCsvApplyInput,
  values: AdminCsvValues,
  now: string,
  snapshot: string,
): Promise<void> {
  const normalized = normalizeCatalogModel(values.canonical_model);
  const productId = "(SELECT target_id FROM admin_csv_import_changes WHERE operation_id = ?)";
  const statements = [
    ...catalogCsvManufacturerStatements(db, values.manufacturer_id, input.operationId, now),
    db
      .prepare(`SELECT json(CASE WHEN (${BUCKET_SQL}) = ? AND EXISTS (
      SELECT 1 FROM knowledge_catalog_manufacturers WHERE id = ? AND verification_status = 'verified'
    ) THEN 'true' ELSE 'csv_import_conflict' END)`)
      .bind(...bucketParameters(values), snapshot, values.manufacturer_id),
    db
      .prepare(`INSERT INTO knowledge_catalog_products(
      manufacturer_id, canonical_model, normalized_model, canonical_name, lifecycle_status,
      verification_status, review_status, first_verified_at, last_verified_at, last_reviewed_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'verified', 'current', ?, ?, ?, ?, ?)`)
      .bind(
        values.manufacturer_id,
        values.canonical_model,
        normalized,
        values.canonical_name,
        values.lifecycle_status,
        now,
        now,
        now,
        now,
        now,
      ),
    // Resolve the generated ID inside this transaction. Trigger writes must not redirect it.
    db
      .prepare(`INSERT INTO admin_csv_import_changes(
      operation_id, target_kind, target_id, before_json, after_json, revision, status, phase, created_at, updated_at
    ) SELECT ?, 'catalog', id, ?, ?, ?, 'pending', 2, ?, ? FROM knowledge_catalog_products
      WHERE manufacturer_id = ? AND normalized_model = ?`)
      .bind(
        input.operationId,
        JSON.stringify({ created: true, values: input.change.original.values }),
        JSON.stringify(values),
        input.revision,
        now,
        now,
        values.manufacturer_id,
        normalized,
      ),
  ];
  for (const category of catalogAdminCategoryIds(values.primary_category_id)) {
    statements.push(
      db
        .prepare(`INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
      VALUES (${productId}, ?, ?)`)
        .bind(input.operationId, category, category === values.primary_category_id ? 1 : 0),
    );
  }
  statements.push(
    db
      .prepare(`INSERT INTO knowledge_catalog_aliases(product_id, alias, normalized_alias, alias_type, created_at)
      VALUES (${productId}, ?, ?, 'model', ?)`)
      .bind(input.operationId, values.canonical_model, normalized, now),
    db
      .prepare(`INSERT INTO knowledge_catalog_sources(
      product_id, source_type, source_url, retrieved_at, content_hash, status, created_at, updated_at
    ) VALUES (${productId}, 'manual_verified', ?, ?, '', 'active', ?, ?)`)
      .bind(input.operationId, "manual://csv-import/" + input.operationId, now, now, now),
  );
  await db.batch(statements);
}
