import { firstMeasured } from "./read-accounting.js";
import { withinD1Budget } from "./invocation-budget.js";
import { PUBLIC_META_ENTITY_PAGE, refreshPublicMetaFacets } from "./public-meta-facets.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";

/** Counts are refreshed globally, independently of HTTP traffic and edge-cache misses. */
export const PUBLIC_META_REFRESH_MS = 60 * 60 * 1000;
export const PUBLIC_META_MAX_PAGES = 5;

export interface MetaBatchRow {
  facet_kind?: "manufacturer" | "shop";
  manufacturer_id?: string;
  value?: string;
  facet_id?: string;
  facet_value?: string;
  active_product_count?: number | null;
  active_count?: number | null;
  unclassified_count?: number | null;
  low_confidence_count?: number | null;
  legacy_residue_count?: number | null;
  legacy_other_count?: number | null;
  migrated_shift_count?: number | null;
}

export interface PublicMetaSnapshot {
  generatedAt: string;
  batches: { results: MetaBatchRow[] }[];
}

export async function readPublicMetaSnapshot(db: ReadableDatabase): Promise<PublicMetaSnapshot> {
  const row = await firstMeasured<{ payload_json: string; generated_at: string }>(
    db.prepare("SELECT payload_json, generated_at FROM public_meta_snapshot WHERE singleton = 1"),
  );
  if (!row) throw new Error("Public metadata snapshot is missing; apply D1 migrations");
  return { generatedAt: row.generated_at, batches: JSON.parse(row.payload_json) };
}

/** Drain a bounded number of facet pages, then publish only when all count dimensions are current.
 * The legacy audit is recomputed only when its facts changed. Counts and timestamp swap together;
 * failures or a remaining facet backlog retain the previous complete snapshot and its age.
 */
export async function refreshPublicMetaSnapshot(db: QueryableDatabase, now = new Date()) {
  return withinD1Budget(db, 2 * PUBLIC_META_MAX_PAGES + 1, async () => {
    let processedEntities = 0;
    for (let page = 0; page < PUBLIC_META_MAX_PAGES; page += 1) {
      const processed = await refreshPublicMetaFacets(db);
      processedEntities += processed;
      if (processed < PUBLIC_META_ENTITY_PAGE) break;
    }
    const results = await db.batch<{ pending: number }>([
      db.prepare(`UPDATE public_meta_counts SET row_count = (
        SELECT COUNT(DISTINCT entity_id) FROM taxonomy_v3_migration_audit
        WHERE entity_type = 'product_primary' AND legacy_category_id <> canonical_category_id
      ) WHERE kind = 'taxonomy' AND group_key = '' AND value = 'migrated_shift_count'
        AND EXISTS (SELECT 1 FROM public_meta_audit_dirty)`),
      db.prepare("DELETE FROM public_meta_audit_dirty"),
      db
        .prepare(`
    INSERT INTO public_meta_snapshot (singleton, payload_json, generated_at)
    SELECT 1, (SELECT payload_json FROM public_meta_incremental_aggregate), ?
    WHERE NOT EXISTS (SELECT 1 FROM public_meta_dirty_entities)
      AND NOT EXISTS (
      SELECT 1 FROM public_meta_snapshot WHERE singleton = 1 AND generated_at > ?
    )
    ON CONFLICT(singleton) DO UPDATE SET
      payload_json = excluded.payload_json, generated_at = excluded.generated_at
  `)
        .bind(now.toISOString(), new Date(now.getTime() - PUBLIC_META_REFRESH_MS).toISOString()),
      db.prepare("SELECT EXISTS (SELECT 1 FROM public_meta_dirty_entities) AS pending"),
    ]);
    return {
      refreshed: Number(results[2]?.meta?.changes || 0) > 0,
      pending: Number(results[3]?.results?.[0]?.pending || 0) > 0,
      processedEntities,
    };
  });
}
