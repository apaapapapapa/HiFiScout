import { RESOLUTION_VERSIONS } from "../catalog/resolution-versions.js";
import type { QueryableDatabase } from "./types.js";

function changes(result: D1Result<unknown>): number {
  return Number(result.meta?.changes || 0);
}

/**
 * Resolve automatic queue entries whose owed stage was already satisfied by another replay.
 *
 * Automatic stage jobs are durable and stage-specific, while a derived replay updates manufacturer,
 * model and category together and then refreshes every downstream projection. That means an older
 * queued job can become redundant before it is claimed. Re-running its projection chain is both
 * expensive and unnecessary.
 *
 * Active leases are never touched. An expired processing lease is equivalent to claimable work and
 * may be compacted only when the owed stage is current and the projection dirty marker is clear.
 * Manual/full-rebuild work (`reprocess_listing`) is deliberately outside this query.
 */
export async function compactSupersededAutomaticRemediationJobs(
  db: QueryableDatabase,
  now = new Date().toISOString(),
): Promise<number> {
  const versions = RESOLUTION_VERSIONS;
  const result = await db
    .prepare(`
      UPDATE data_quality_remediation_queue AS q
      SET status = 'resolved',
          resolved_at = ?,
          claimed_at = NULL,
          lease_expires_at = NULL,
          last_error = '',
          updated_at = ?
      WHERE (
          q.status = 'pending'
          OR (
            q.status = 'processing'
            AND (q.lease_expires_at IS NULL OR q.lease_expires_at <= ?)
          )
        )
        AND q.source = 'scheduled_sweep'
        AND q.reason = 'automatic_data_quality_remediation'
        AND q.listing_product_id IS NOT NULL
        AND q.work_type IN (
          'resolve_manufacturer', 'resolve_model', 'classify_category',
          'resolve_identity', 'rebuild_search_entity'
        )
        AND EXISTS (
          SELECT 1
          FROM products p
          LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
          WHERE p.id = q.listing_product_id
            AND (
              p.is_active = 0
              OR (
                p.remediation_projection_required = 0
                AND (
                  (q.work_type = 'resolve_manufacturer' AND p.manufacturer_resolver_version >= ?)
                  OR (q.work_type = 'resolve_model' AND p.model_resolver_version >= ?)
                  OR (
                    q.work_type = 'classify_category'
                    AND COALESCE(
                      CAST(json_extract(p.metadata_json, '$.categoryClassification.version') AS INTEGER),
                      0
                    ) >= ?
                  )
                  OR (
                    q.work_type = 'resolve_identity'
                    AND COALESCE(r.identity_resolver_version, 0) >= ?
                  )
                  OR q.work_type = 'rebuild_search_entity'
                )
              )
            )
        )
    `)
    .bind(
      now,
      now,
      now,
      versions.manufacturer,
      versions.model,
      versions.category,
      versions.identity,
    )
    .run();
  return changes(result);
}
