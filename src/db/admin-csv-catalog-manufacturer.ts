import { bootstrapManufacturers } from "../catalog/manufacturers.js";
import { MANUFACTURER_RESOLVER_VERSION } from "../catalog/manufacturer-resolver.js";
import type { QueryableDatabase } from "./types.js";

// Only canonical IDs explicitly present in the trusted code registry qualify. A synthesized
// filter ID, seller spelling, or existing product is not manufacturer verification evidence.
export function catalogCsvBootstrapManufacturer(id: string) {
  return bootstrapManufacturers().find((manufacturer) => manufacturer.id === id);
}

/** Materialize missing code evidence only inside the authorized product-creation transaction. */
export function catalogCsvManufacturerStatements(
  db: QueryableDatabase,
  id: string,
  operationId: string,
  now: string,
): D1PreparedStatement[] {
  const manufacturer = catalogCsvBootstrapManufacturer(id);
  if (!manufacturer) return [];
  return [
    db
      .prepare(`INSERT INTO knowledge_catalog_manufacturers(
        id, canonical_name, verification_status, source, provenance_json, created_at, updated_at
      ) SELECT ?, ?, 'verified', 'code_bootstrap', ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM knowledge_catalog_manufacturers WHERE id = ?)`)
      .bind(
        id,
        manufacturer.name,
        JSON.stringify({
          reason: "catalog_csv_creation",
          operationId,
          ruleVersion: MANUFACTURER_RESOLVER_VERSION,
        }),
        now,
        now,
        id,
      ),
  ];
}
