import { RESOLUTION_VERSIONS } from "../catalog/resolution-versions.js";
import { compactSupersededAutomaticRemediationJobs } from "../db/data-quality-remediation-compaction.js";
import { runDataQualityRemediationSweep } from "../db/data-quality-remediation-service.js";
import type { QueryableDatabase } from "../db/types.js";

interface RemediationDrainEnv {
  DB: D1Database;
}

interface ReplayStatusRow {
  active_listings: number;
  stale_manufacturer: number;
  stale_model: number;
  stale_category: number;
  stale_identity: number;
  projection_dirty: number;
}

interface QueueStatusRow {
  pending: number;
  processing: number;
  resolved: number;
  failed: number;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function replayStatus(db: QueryableDatabase) {
  const versions = RESOLUTION_VERSIONS;
  const [stale, queue] = await Promise.all([
    db
      .prepare(`
        SELECT
          COUNT(*) AS active_listings,
          SUM(CASE WHEN p.manufacturer_resolver_version < ? THEN 1 ELSE 0 END) AS stale_manufacturer,
          SUM(CASE WHEN p.model_resolver_version < ? THEN 1 ELSE 0 END) AS stale_model,
          SUM(CASE
            WHEN COALESCE(CAST(json_extract(p.metadata_json, '$.categoryClassification.version') AS INTEGER), 0) < ?
            THEN 1 ELSE 0 END) AS stale_category,
          SUM(CASE WHEN COALESCE(r.identity_resolver_version, 0) < ? THEN 1 ELSE 0 END) AS stale_identity,
          SUM(CASE WHEN p.remediation_projection_required = 1 THEN 1 ELSE 0 END) AS projection_dirty
        FROM products p
        LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
        WHERE p.is_active = 1
      `)
      .bind(versions.manufacturer, versions.model, versions.category, versions.identity)
      .first<ReplayStatusRow>(),
    db
      .prepare(`
        SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
          SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM data_quality_remediation_queue
      `)
      .first<QueueStatusRow>(),
  ]);

  const safeStale = stale || {
    active_listings: 0,
    stale_manufacturer: 0,
    stale_model: 0,
    stale_category: 0,
    stale_identity: 0,
    projection_dirty: 0,
  };
  const safeQueue = queue || { pending: 0, processing: 0, resolved: 0, failed: 0 };
  const staleTotal =
    Number(safeStale.stale_manufacturer || 0) +
    Number(safeStale.stale_model || 0) +
    Number(safeStale.stale_category || 0) +
    Number(safeStale.stale_identity || 0) +
    Number(safeStale.projection_dirty || 0);

  return {
    versions,
    activeListings: Number(safeStale.active_listings || 0),
    stale: {
      manufacturer: Number(safeStale.stale_manufacturer || 0),
      model: Number(safeStale.stale_model || 0),
      category: Number(safeStale.stale_category || 0),
      identity: Number(safeStale.stale_identity || 0),
      projection: Number(safeStale.projection_dirty || 0),
      total: staleTotal,
    },
    queue: {
      pending: Number(safeQueue.pending || 0),
      processing: Number(safeQueue.processing || 0),
      resolved: Number(safeQueue.resolved || 0),
      failed: Number(safeQueue.failed || 0),
    },
  };
}

/**
 * Local-only operational worker used by GitHub Actions with a remote D1 binding.
 * It deliberately exposes only bounded remediation operations; it is never deployed.
 */
export default {
  async fetch(request: Request, env: RemediationDrainEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      return json(await replayStatus(env.DB));
    }
    if (request.method === "POST" && url.pathname === "/compact") {
      const compacted = await compactSupersededAutomaticRemediationJobs(env.DB);
      return json({ compacted, after: await replayStatus(env.DB) });
    }
    if (request.method === "POST" && url.pathname === "/sweep") {
      const before = await replayStatus(env.DB);
      const sweep = await runDataQualityRemediationSweep(env.DB, {
        seedLimit: 250,
        // Keep one remote request small enough that a pathological shop/listing group cannot hold
        // the entire drain workflow hostage. The workflow runs more sweeps to preserve throughput.
        claimLimit: 10,
        leaseSeconds: 900,
      });
      const after = await replayStatus(env.DB);
      return json({ before, sweep, after });
    }
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<RemediationDrainEnv>;
