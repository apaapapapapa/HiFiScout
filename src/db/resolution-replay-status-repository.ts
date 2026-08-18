import { RESOLUTION_VERSIONS } from "../catalog/resolution-versions.js";
import type { QueryableDatabase } from "./types.js";

interface ResolutionReplayRow extends Record<string, unknown> {
  active_listings?: number | null;
  stale_manufacturer?: number | null;
  stale_model?: number | null;
  stale_category?: number | null;
  stale_identity?: number | null;
  projection_dirty?: number | null;
  stale_listings?: number | null;
}

interface QueueStatusRow extends Record<string, unknown> {
  pending?: number | null;
  processing?: number | null;
  resolved?: number | null;
  failed?: number | null;
}

export interface ResolutionReplayStageStatus {
  targetVersion: number;
  upToDate: number;
  stale: number;
  progressPercent: number;
}

export interface ResolutionReplayStatus {
  checkedAt: string;
  versions: typeof RESOLUTION_VERSIONS;
  activeListings: number;
  overall: {
    upToDateListings: number;
    staleListings: number;
    staleSignals: number;
    progressPercent: number;
    complete: boolean;
    blocked: boolean;
  };
  stages: {
    manufacturer: ResolutionReplayStageStatus;
    model: ResolutionReplayStageStatus;
    category: ResolutionReplayStageStatus;
    identity: ResolutionReplayStageStatus;
    projection: {
      dirty: number;
    };
  };
  queue: {
    pending: number;
    processing: number;
    resolved: number;
    failed: number;
  };
}

function number(value: unknown): number {
  return Number(value || 0);
}

function progressPercent(upToDate: number, total: number): number {
  if (total <= 0) return 100;
  return Math.round((upToDate / total) * 10_000) / 100;
}

function stage(
  targetVersion: number,
  stale: number,
  activeListings: number,
): ResolutionReplayStageStatus {
  const upToDate = Math.max(0, activeListings - stale);
  return {
    targetVersion,
    upToDate,
    stale,
    progressPercent: progressPercent(upToDate, activeListings),
  };
}

/**
 * Current deterministic resolver/replay convergence status for active listings.
 *
 * The target versions come from the same resolver-owned tuple used by the replay drain, so this
 * stays useful for future version bumps without adding version-specific monitoring code.
 */
export async function resolutionReplayStatus(
  db: QueryableDatabase,
): Promise<ResolutionReplayStatus> {
  const versions = RESOLUTION_VERSIONS;
  const [replayRow, queueRow] = await Promise.all([
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
          SUM(CASE WHEN p.remediation_projection_required = 1 THEN 1 ELSE 0 END) AS projection_dirty,
          SUM(CASE WHEN
            p.manufacturer_resolver_version < ? OR
            p.model_resolver_version < ? OR
            COALESCE(CAST(json_extract(p.metadata_json, '$.categoryClassification.version') AS INTEGER), 0) < ? OR
            COALESCE(r.identity_resolver_version, 0) < ? OR
            p.remediation_projection_required = 1
          THEN 1 ELSE 0 END) AS stale_listings
        FROM products p
        LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
        WHERE p.is_active = 1
      `)
      .bind(
        versions.manufacturer,
        versions.model,
        versions.category,
        versions.identity,
        versions.manufacturer,
        versions.model,
        versions.category,
        versions.identity,
      )
      .first<ResolutionReplayRow>(),
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

  const replay = replayRow || {};
  const queue = queueRow || {};
  const activeListings = number(replay.active_listings);
  const staleManufacturer = number(replay.stale_manufacturer);
  const staleModel = number(replay.stale_model);
  const staleCategory = number(replay.stale_category);
  const staleIdentity = number(replay.stale_identity);
  const projectionDirty = number(replay.projection_dirty);
  const staleListings = number(replay.stale_listings);
  const staleSignals =
    staleManufacturer + staleModel + staleCategory + staleIdentity + projectionDirty;
  const failed = number(queue.failed);

  return {
    checkedAt: new Date().toISOString(),
    versions,
    activeListings,
    overall: {
      upToDateListings: Math.max(0, activeListings - staleListings),
      staleListings,
      staleSignals,
      progressPercent: progressPercent(Math.max(0, activeListings - staleListings), activeListings),
      complete: staleSignals === 0,
      blocked: staleSignals > 0 && failed > 0,
    },
    stages: {
      manufacturer: stage(versions.manufacturer, staleManufacturer, activeListings),
      model: stage(versions.model, staleModel, activeListings),
      category: stage(versions.category, staleCategory, activeListings),
      identity: stage(versions.identity, staleIdentity, activeListings),
      projection: { dirty: projectionDirty },
    },
    queue: {
      pending: number(queue.pending),
      processing: number(queue.processing),
      resolved: number(queue.resolved),
      failed,
    },
  };
}
