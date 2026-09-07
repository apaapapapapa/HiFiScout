import type {
  AdminManufacturerPage,
  AdminManufacturerQuery,
} from "../api/admin-manufacturer-contracts.js";
import { normalizeManufacturerKey } from "../catalog/manufacturers.js";
import type { ReadableDatabase } from "./types.js";

/** Search the verified manufacturer registry only; no listing/catalog aggregation or writes. */
export async function listAdminManufacturers(
  db: ReadableDatabase,
  options: AdminManufacturerQuery,
): Promise<AdminManufacturerPage> {
  const params: (string | number)[] = [options.afterId];
  const query = options.query.normalize("NFKC").trim().toLowerCase();
  let search = "";
  if (query) {
    const alias = normalizeManufacturerKey(query);
    search = `AND (INSTR(m.id, ?) > 0 OR INSTR(LOWER(m.canonical_name), ?) > 0 OR
      (? <> '' AND EXISTS (SELECT 1 FROM knowledge_catalog_manufacturer_aliases a
        WHERE a.manufacturer_id = m.id AND a.verification_status = 'verified'
        AND INSTR(a.normalized_alias, ?) > 0)))`;
    params.push(query, query, alias, alias);
  }
  params.push(options.limit + 1);
  const result = await db
    .prepare(`
    SELECT m.id, m.canonical_name AS name FROM knowledge_catalog_manufacturers m
    WHERE m.verification_status = 'verified' AND m.id > ? ${search}
    ORDER BY m.id LIMIT ?
  `)
    .bind(...params)
    .all<{ id: string; name: string }>();
  const items = result.results.slice(0, options.limit).map(({ id, name }) => ({ id, name }));
  const hasMore = result.results.length > options.limit;
  return { items, hasMore, nextAfterId: hasMore ? items.at(-1)!.id : null };
}
