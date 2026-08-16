import { RESOLUTION_VERSIONS } from "../../src/catalog/resolution-versions.js";
import { enqueueDataQualityRemediation } from "../../src/db/data-quality-remediation-queue-repository.js";
import type { QueryableDatabase } from "../../src/db/types.js";

interface StaleTargetRow {
  id: number;
  remediation_projection_token: string;
}

export interface StaleTargetRecoveryResult {
  selectedCount: number;
  workKeys: string[];
}

const CATEGORY_VERSION_EXPRESSION =
  "COALESCE(CAST(json_extract(p.metadata_json, '$.categoryClassification.version') AS INTEGER), 0)";

function recoveryWorkKey(row: StaleTargetRow): string {
  const versions = RESOLUTION_VERSIONS;
  const projectionToken = encodeURIComponent(row.remediation_projection_token || "none");
  return [
    "drain-stale-target-v1",
    `listing:${Number(row.id)}`,
    `manufacturer:${versions.manufacturer}`,
    `model:${versions.model}`,
    `category:${versions.category}`,
    `identity:${versions.identity}`,
    `projection:${projectionToken}`,
  ].join(":");
}

/**
 * Administrative escape hatch for stale signals whose historical `auto:*` work key already exists.
 *
 * The scheduled selector's legacy deterministic key describes the versions stored on the listing.
 * A resolver target can move while those stored versions do not, so an old resolved queue row can
 * suppress a genuinely new replay generation. The production drain detects that state only after
 * normal queue top-up finds nothing. This recovery then creates a separate durable `reprocess_listing`
 * job whose identity is based on the *target* resolver generation (and projection token), preserving
 * queue history without deleting or rewriting old resolved jobs.
 *
 * The target-aware key is intentionally idempotent. If one recovery attempt completes but the same
 * signal remains stale, this function will not create an infinite retry loop; the drain will fail
 * visibly instead. A later resolver-version bump or a new projection token naturally creates a new
 * generation.
 */
export async function enqueueStaleTargetReplayRecovery(
  db: QueryableDatabase,
  {
    limit = 250,
    now = new Date().toISOString(),
  }: { limit?: number; now?: string } = {},
): Promise<StaleTargetRecoveryResult> {
  const boundedLimit = Math.min(250, Math.max(1, Number(limit) || 250));
  const versions = RESOLUTION_VERSIONS;
  const rows = await db
    .prepare(`
      SELECT
        p.id,
        COALESCE(p.remediation_projection_token, '') AS remediation_projection_token
      FROM products p
      LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
      WHERE p.is_active = 1
        AND (
          p.manufacturer_resolver_version < ?
          OR p.model_resolver_version < ?
          OR ${CATEGORY_VERSION_EXPRESSION} < ?
          OR COALESCE(r.identity_resolver_version, 0) < ?
          OR p.remediation_projection_required = 1
        )
      ORDER BY p.id
      LIMIT ?
    `)
    .bind(
      versions.manufacturer,
      versions.model,
      versions.category,
      versions.identity,
      boundedLimit,
    )
    .all<StaleTargetRow>();

  const workKeys: string[] = [];
  for (const row of rows.results || []) {
    const workKey = recoveryWorkKey(row);
    const inserted = await enqueueDataQualityRemediation(db, {
      workKey,
      workType: "reprocess_listing",
      listingProductId: Number(row.id),
      entityId: String(row.id),
      reason: "stale_signal_blocked_by_historical_automatic_key",
      source: "resolver_replay_drain_target_recovery_v1",
      priority: 125,
      now,
    });
    if (inserted) workKeys.push(workKey);
  }

  return { selectedCount: (rows.results || []).length, workKeys };
}
