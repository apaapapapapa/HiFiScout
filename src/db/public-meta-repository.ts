import { firstMeasured } from "./read-accounting.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";

/** Counts are refreshed globally, independently of HTTP traffic and edge-cache misses. */
export const PUBLIC_META_REFRESH_MS = 15 * 60 * 1000;

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

/** SQL evaluates the aggregate only after the freshness guard. One statement atomically swaps
 * all counts and their timestamp; failure leaves the previous complete snapshot available.
 * Also recreates a missing snapshot without making a public request pay for the aggregation.
 */
export async function refreshPublicMetaSnapshot(db: QueryableDatabase, now = new Date()) {
  const result = await db
    .prepare(`
    INSERT INTO public_meta_snapshot (singleton, payload_json, generated_at)
    SELECT 1, (SELECT payload_json FROM public_meta_aggregate), ?
    WHERE NOT EXISTS (
      SELECT 1 FROM public_meta_snapshot WHERE singleton = 1 AND generated_at > ?
    )
    ON CONFLICT(singleton) DO UPDATE SET
      payload_json = excluded.payload_json, generated_at = excluded.generated_at
  `)
    .bind(now.toISOString(), new Date(now.getTime() - PUBLIC_META_REFRESH_MS).toISOString())
    .run();
  return { refreshed: Number(result.meta?.changes || 0) > 0 };
}
