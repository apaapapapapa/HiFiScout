import { RESOLUTION_VERSIONS } from "../catalog/resolution-versions.js";
import type { QueryableDatabase } from "./types.js";

export type DataQualityRemediationWorkType =
  | "resolve_manufacturer"
  | "resolve_model"
  | "classify_category"
  | "resolve_identity"
  | "reprocess_listing"
  | "rebuild_search_entity";

export type DataQualityRemediationStatus = "pending" | "processing" | "resolved" | "failed";

export interface DataQualityRemediationJob {
  id: number;
  workKey: string;
  workType: DataQualityRemediationWorkType;
  listingProductId: number | null;
  entityId: string;
  reason: string;
  source: string;
  status: DataQualityRemediationStatus;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  resolvedAt: string | null;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

interface QueueRow {
  id: number;
  work_key: string;
  work_type: DataQualityRemediationWorkType;
  listing_product_id: number | null;
  entity_id: string;
  reason: string;
  source: string;
  status: DataQualityRemediationStatus;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  claimed_at: string | null;
  lease_expires_at: string | null;
  resolved_at: string | null;
  last_error: string;
  created_at: string;
  updated_at: string;
}

interface CandidateRow {
  id: number;
  work_type: DataQualityRemediationWorkType;
  manufacturer_resolver_version: number;
  model_resolver_version: number;
  category_classifier_version: number;
  identity_resolver_version: number;
}

interface FullRebuildRow {
  id: number;
}

interface QueueMetricRow {
  pending: number | null;
  processing: number | null;
  resolved: number | null;
  failed: number | null;
  oldest_pending_at: string | null;
}

export interface QueueMetrics {
  pending: number;
  processing: number;
  resolved: number;
  failed: number;
  backlog: number;
  oldestPendingAt: string | null;
}

export interface EnqueueRemediationInput {
  workKey: string;
  workType: DataQualityRemediationWorkType;
  listingProductId?: number | null;
  entityId?: string;
  reason: string;
  source?: string;
  priority?: number;
  maxAttempts?: number;
  availableAt?: string;
  now?: string;
}

export interface SeedRemediationResult {
  selectedCount: number;
  workKeys: string[];
}

export interface FullRebuildOptions {
  afterId?: number;
  limit?: number;
  reason?: string;
  source?: string;
  rebuildKey?: string;
  now?: string;
}

export interface FullRebuildResult extends SeedRemediationResult {
  nextAfterId: number | null;
  hasMore: boolean;
}

const DEFAULT_SEED_LIMIT = 50;
const MAX_SEED_LIMIT = 250;
const DEFAULT_CLAIM_LIMIT = 10;
const MAX_CLAIM_LIMIT = 50;
const DEFAULT_LEASE_SECONDS = 300;

function bounded(value: number | undefined, fallback: number, max: number): number {
  return Math.min(max, Math.max(1, Number(value) || fallback));
}

function number(value: unknown): number {
  return Number(value || 0);
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + Math.max(1, seconds) * 1000).toISOString();
}

function rowToJob(row: QueueRow): DataQualityRemediationJob {
  return {
    id: number(row.id),
    workKey: row.work_key,
    workType: row.work_type,
    listingProductId: row.listing_product_id == null ? null : number(row.listing_product_id),
    entityId: row.entity_id || "",
    reason: row.reason,
    source: row.source || "",
    status: row.status,
    priority: number(row.priority),
    attemptCount: number(row.attempt_count),
    maxAttempts: number(row.max_attempts),
    availableAt: row.available_at,
    claimedAt: row.claimed_at || null,
    leaseExpiresAt: row.lease_expires_at || null,
    resolvedAt: row.resolved_at || null,
    lastError: row.last_error || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function enqueueDataQualityRemediation(
  db: QueryableDatabase,
  input: EnqueueRemediationInput,
): Promise<boolean> {
  const now = input.now || new Date().toISOString();
  const result = await db
    .prepare(`
      INSERT INTO data_quality_remediation_queue(
        work_key, work_type, listing_product_id, entity_id, reason, source, status,
        priority, max_attempts, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
      ON CONFLICT(work_key) DO NOTHING
    `)
    .bind(
      input.workKey,
      input.workType,
      input.listingProductId ?? null,
      input.entityId || "",
      input.reason,
      input.source || "",
      Number(input.priority) || 100,
      Math.max(1, Number(input.maxAttempts) || 3),
      input.availableAt || now,
      now,
      now,
    )
    .run();
  return number(result?.meta?.changes) > 0;
}

function automaticWorkKey(row: CandidateRow): string {
  return [
    "auto",
    row.work_type,
    `listing:${row.id}`,
    `manufacturer:${row.manufacturer_resolver_version}`,
    `model:${row.model_resolver_version}`,
    `category:${row.category_classifier_version}`,
    `identity:${row.identity_resolver_version}`,
  ].join(":");
}

/** Category is the one stage whose version is stored inside `metadata_json`, not as a column. */
const CATEGORY_VERSION_EXPRESSION =
  "COALESCE(CAST(json_extract(p.metadata_json, '$.categoryClassification.version') AS INTEGER), 0)";

/**
 * One indexed way into the stale set.
 *
 * Staleness used to be a single disjunction over ten columns. No index can serve a disjunction, so
 * every five-minute tick read every listing — a cost that grew with the catalog while the work it
 * was looking for shrank. Splitting it gives each condition its own selector, and each selector its
 * own index, so a drained stage costs a seek that finds nothing instead of a table read.
 *
 * `INDEXED BY` is the point, not decoration. These statements exist because of the index they name;
 * a plan that quietly fell back to reading the table would restore exactly the cost this removes,
 * so the statement is made to fail instead. `test/remediation-query-plans.test.ts` explains each.
 */
interface StaleSelector {
  /** Diagnostic name, and what a failing query plan points at. */
  readonly key: string;
  /** Driving table with its required index, plus the join that completes the candidate row. */
  readonly source: string;
  /** This selector's slice of the stale set. */
  readonly where: string;
  /** Binds the predicate needs, in the order it uses them. */
  readonly binds: readonly number[];
}

/** Listings drive the selector; the identity row may not exist yet. */
function listingSource(index: string): string {
  return `products p INDEXED BY ${index}
        LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id`;
}

/** Identity drives the selector, which also means the listing is reached by primary key. */
function identitySource(index: string): string {
  return `product_identity_resolutions r INDEXED BY ${index}
        JOIN products p ON p.id = r.listing_product_id`;
}

/**
 * Every condition the old disjunction contained, one indexed selector each.
 *
 * The status predicates are written as equalities rather than the `<> 'resolved'` the work-type CASE
 * still uses, because `<>` cannot seek. Both spellings select the same rows: each column carries a
 * CHECK constraint listing its complete domain (0005, 0017, 0023), so "not resolved" and "one of the
 * remaining values" are the same set.
 */
const STALE_SELECTORS: readonly StaleSelector[] = [
  {
    key: "manufacturer_version",
    source: listingSource("idx_products_manufacturer_resolver_version"),
    where: "p.is_active = 1 AND p.manufacturer_resolver_version < ?",
    binds: [RESOLUTION_VERSIONS.manufacturer],
  },
  {
    key: "model_version",
    source: listingSource("idx_products_model_resolver_version"),
    where: "p.is_active = 1 AND p.model_resolver_version < ?",
    binds: [RESOLUTION_VERSIONS.model],
  },
  {
    key: "category_version",
    source: listingSource("idx_products_category_classifier_version"),
    where: `p.is_active = 1 AND ${CATEGORY_VERSION_EXPRESSION} < ?`,
    binds: [RESOLUTION_VERSIONS.category],
  },
  {
    key: "identity_version",
    source: identitySource("idx_product_identity_resolver_version"),
    where: "p.is_active = 1 AND r.identity_resolver_version < ?",
    binds: [RESOLUTION_VERSIONS.identity],
  },
  {
    key: "identity_unresolved",
    source: identitySource("idx_product_identity_status"),
    where: "p.is_active = 1 AND r.status = 'unresolved'",
    binds: [],
  },
  {
    key: "identity_missing",
    source: listingSource("idx_products_active_ids"),
    where: "p.is_active = 1 AND r.listing_product_id IS NULL",
    binds: [],
  },
  {
    key: "projection_required",
    source: listingSource("idx_products_remediation_projection_required"),
    where: "p.is_active = 1 AND p.remediation_projection_required = 1",
    binds: [],
  },
  {
    key: "manufacturer_unresolved",
    source: listingSource("idx_products_manufacturer_resolution"),
    where: "p.is_active = 1 AND p.manufacturer_resolution_status IN ('candidate', 'unresolved')",
    binds: [],
  },
  {
    key: "model_unresolved",
    source: listingSource("idx_products_model_resolution"),
    where: "p.is_active = 1 AND p.model_resolution_status IN ('candidate', 'unresolved')",
    binds: [],
  },
  {
    key: "category_unclassified",
    source: listingSource("idx_products_classification_status"),
    where: "p.is_active = 1 AND p.classification_status = 'unclassified'",
    binds: [],
  },
];

/**
 * The candidate projection, reached through one selector.
 *
 * Only the driving table and predicate vary. Work type and work key are computed from the same
 * listing/identity state in every selector, so the same listing reached two ways produces the same
 * row and deduplicates cleanly.
 */
function staleCandidateSql(selector: StaleSelector): string {
  return `
      WITH candidates AS (
        SELECT
          p.id,
          CASE
            WHEN p.manufacturer_resolver_version < ? THEN 'resolve_manufacturer'
            WHEN p.model_resolver_version < ? THEN 'resolve_model'
            WHEN ${CATEGORY_VERSION_EXPRESSION} < ? THEN 'classify_category'
            WHEN COALESCE(r.identity_resolver_version, 0) < ? THEN 'resolve_identity'
            WHEN p.remediation_projection_required = 1 THEN 'rebuild_search_entity'
            WHEN p.manufacturer_resolution_status <> 'resolved' THEN 'resolve_manufacturer'
            WHEN p.model_resolution_status <> 'resolved' THEN 'resolve_model'
            WHEN p.classification_status <> 'classified' THEN 'classify_category'
            WHEN r.listing_product_id IS NULL OR r.status <> 'matched' THEN 'resolve_identity'
            ELSE 'reprocess_listing'
          END AS work_type,
          p.manufacturer_resolver_version,
          p.model_resolver_version,
          ${CATEGORY_VERSION_EXPRESSION} AS category_classifier_version,
          COALESCE(r.identity_resolver_version, 0) AS identity_resolver_version
        FROM ${selector.source}
        WHERE ${selector.where}
      ), keyed AS (
        SELECT
          c.*,
          'auto:' || c.work_type ||
          ':listing:' || c.id ||
          ':manufacturer:' || c.manufacturer_resolver_version ||
          ':model:' || c.model_resolver_version ||
          ':category:' || c.category_classifier_version ||
          ':identity:' || c.identity_resolver_version AS work_key
        FROM candidates c
      )
      SELECT
        k.id,
        k.work_type,
        k.manufacturer_resolver_version,
        k.model_resolver_version,
        k.category_classifier_version,
        k.identity_resolver_version
      FROM keyed k
      WHERE NOT EXISTS (
        SELECT 1
        FROM data_quality_remediation_queue q
        WHERE q.work_key = k.work_key
      )
      ORDER BY k.id
      LIMIT ?
    `;
}

/**
 * Convert only actionable/stale listings into durable work. Candidates whose exact deterministic
 * work key already exists are excluded before LIMIT is applied, so resolved/unresolved low ids can
 * never starve later stale listings. A resolver/dependency change naturally produces a new key.
 */
export async function seedDataQualityRemediationQueue(
  db: QueryableDatabase,
  {
    limit = DEFAULT_SEED_LIMIT,
    now = new Date().toISOString(),
  }: { limit?: number; now?: string } = {},
): Promise<SeedRemediationResult> {
  const selectedLimit = bounded(limit, DEFAULT_SEED_LIMIT, MAX_SEED_LIMIT);
  const seen = new Set<number>();
  const candidates: CandidateRow[] = [];
  for (const selector of STALE_SELECTORS) {
    const rows = await db
      .prepare(staleCandidateSql(selector))
      .bind(
        RESOLUTION_VERSIONS.manufacturer,
        RESOLUTION_VERSIONS.model,
        RESOLUTION_VERSIONS.category,
        RESOLUTION_VERSIONS.identity,
        ...selector.binds,
        selectedLimit,
      )
      .all<CandidateRow>();
    for (const row of rows.results || []) {
      const id = number(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push(row);
    }
  }

  // Splitting the selector did not change which listings get picked. Each one already excludes
  // deduplicated keys before its own LIMIT, and a listing among the lowest `selectedLimit` ids of
  // the union has fewer than that many smaller ids inside every selector it matches — so it is
  // returned by each of them, and merging cannot lose it.
  candidates.sort((left, right) => number(left.id) - number(right.id));
  const selected = candidates.slice(0, selectedLimit);
  const workKeys: string[] = [];
  for (const row of selected) {
    const workKey = automaticWorkKey(row);
    const inserted = await enqueueDataQualityRemediation(db, {
      workKey,
      workType: row.work_type,
      listingProductId: number(row.id),
      entityId: String(row.id),
      reason: "automatic_data_quality_remediation",
      source: "scheduled_sweep",
      now,
    });
    if (inserted) workKeys.push(workKey);
  }
  return { selectedCount: selected.length, workKeys };
}

/** Explicit recovery/testing path. Normal scheduled operation never calls this. */
export async function enqueueFullDataQualityRebuild(
  db: QueryableDatabase,
  {
    afterId = 0,
    limit = DEFAULT_SEED_LIMIT,
    reason = "full_rebuild",
    source = "manual",
    rebuildKey = `v${RESOLUTION_VERSIONS.manufacturer}-${RESOLUTION_VERSIONS.model}-${RESOLUTION_VERSIONS.category}-${RESOLUTION_VERSIONS.identity}`,
    now = new Date().toISOString(),
  }: FullRebuildOptions = {},
): Promise<FullRebuildResult> {
  const selectedLimit = bounded(limit, DEFAULT_SEED_LIMIT, MAX_SEED_LIMIT);
  const result = await db
    .prepare(`
      SELECT id
      FROM products
      WHERE is_active = 1 AND id > ?
      ORDER BY id
      LIMIT ?
    `)
    .bind(Math.max(0, Number(afterId) || 0), selectedLimit + 1)
    .all<FullRebuildRow>();
  const allRows = result.results || [];
  const hasMore = allRows.length > selectedLimit;
  const rows = allRows.slice(0, selectedLimit);
  const workKeys: string[] = [];
  for (const row of rows) {
    const workKey = `full:${rebuildKey}:listing:${row.id}`;
    const inserted = await enqueueDataQualityRemediation(db, {
      workKey,
      workType: "reprocess_listing",
      listingProductId: number(row.id),
      entityId: String(row.id),
      reason,
      source,
      now,
      priority: 50,
    });
    if (inserted) workKeys.push(workKey);
  }
  return {
    selectedCount: rows.length,
    workKeys,
    nextAfterId: hasMore && rows.length ? number(rows[rows.length - 1]?.id) : null,
    hasMore,
  };
}

export async function claimDataQualityRemediationBatch(
  db: QueryableDatabase,
  {
    limit = DEFAULT_CLAIM_LIMIT,
    claimedAt = new Date().toISOString(),
    leaseSeconds = DEFAULT_LEASE_SECONDS,
  }: { limit?: number; claimedAt?: string; leaseSeconds?: number } = {},
): Promise<DataQualityRemediationJob[]> {
  const claimLimit = bounded(limit, DEFAULT_CLAIM_LIMIT, MAX_CLAIM_LIMIT);
  const leaseExpiresAt = addSeconds(claimedAt, leaseSeconds);
  // One branch per claimable state. As a single disjunction this could use no index at all — the
  // two states test different columns — and its ORDER BY disagreed with the one claim index, so the
  // queue was read end to end and sorted on every drain. Each branch here walks a partial index
  // that is already in claim order and stops at LIMIT, which also bounds the merge: the outer sort
  // sees at most two batches, never the queue. Taking each state's top rows loses nothing, because
  // a row in the overall top `claimLimit` is also in the top `claimLimit` of its own state.
  const candidates = await db
    .prepare(`
      SELECT id, priority, available_at FROM (
        SELECT id, priority, available_at
        FROM data_quality_remediation_queue INDEXED BY idx_dq_remediation_queue_pending
        WHERE status = 'pending'
          AND available_at <= ?
          AND attempt_count < max_attempts
        ORDER BY priority DESC, available_at, id
        LIMIT ?
      )
      UNION ALL
      SELECT id, priority, available_at FROM (
        SELECT id, priority, available_at
        FROM data_quality_remediation_queue INDEXED BY idx_dq_remediation_queue_processing
        WHERE status = 'processing'
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          AND attempt_count < max_attempts
        ORDER BY priority DESC, available_at, id
        LIMIT ?
      )
      ORDER BY priority DESC, available_at, id
      LIMIT ?
    `)
    .bind(claimedAt, claimLimit, claimedAt, claimLimit, claimLimit)
    .all<{ id: number }>();

  const claimedIds: number[] = [];
  for (const candidate of candidates.results || []) {
    const result = await db
      .prepare(`
        UPDATE data_quality_remediation_queue
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            claimed_at = ?,
            lease_expires_at = ?,
            updated_at = ?
        WHERE id = ?
          AND attempt_count < max_attempts
          AND (
            (status = 'pending' AND available_at <= ?)
            OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
          )
      `)
      .bind(claimedAt, leaseExpiresAt, claimedAt, candidate.id, claimedAt, claimedAt)
      .run();
    if (number(result?.meta?.changes) > 0) claimedIds.push(number(candidate.id));
  }
  if (!claimedIds.length) return [];
  const placeholders = claimedIds.map(() => "?").join(",");
  const rows = await db
    .prepare(`
      SELECT *
      FROM data_quality_remediation_queue
      WHERE id IN (${placeholders}) AND status = 'processing' AND claimed_at = ? AND lease_expires_at = ?
      ORDER BY priority DESC, id
    `)
    .bind(...claimedIds, claimedAt, leaseExpiresAt)
    .all<QueueRow>();
  return (rows.results || []).map(rowToJob);
}

export async function resolveDataQualityRemediationJob(
  db: QueryableDatabase,
  jobId: number,
  resolvedAt = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare(`
      UPDATE data_quality_remediation_queue
      SET status = 'resolved', resolved_at = ?, claimed_at = NULL, lease_expires_at = NULL,
          last_error = '', updated_at = ?
      WHERE id = ? AND status = 'processing'
    `)
    .bind(resolvedAt, resolvedAt, jobId)
    .run();
}

export async function retryOrFailDataQualityRemediationJob(
  db: QueryableDatabase,
  jobId: number,
  error: unknown,
  {
    updatedAt = new Date().toISOString(),
    retryDelaySeconds = 60,
  }: { updatedAt?: string; retryDelaySeconds?: number } = {},
): Promise<DataQualityRemediationStatus> {
  const row = await db
    .prepare(`SELECT attempt_count, max_attempts FROM data_quality_remediation_queue WHERE id = ?`)
    .bind(jobId)
    .first<{ attempt_count: number; max_attempts: number }>();
  if (!row) return "failed";
  const terminal = number(row.attempt_count) >= number(row.max_attempts);
  const status: DataQualityRemediationStatus = terminal ? "failed" : "pending";
  const availableAt = terminal ? updatedAt : addSeconds(updatedAt, retryDelaySeconds);
  await db
    .prepare(`
      UPDATE data_quality_remediation_queue
      SET status = ?, available_at = ?, claimed_at = NULL, lease_expires_at = NULL,
          resolved_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
          last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'processing'
    `)
    .bind(
      status,
      availableAt,
      status,
      updatedAt,
      String(error || "unknown remediation failure").slice(0, 1000),
      updatedAt,
      jobId,
    )
    .run();
  return status;
}

export async function dataQualityRemediationQueueMetrics(
  db: QueryableDatabase,
): Promise<QueueMetrics> {
  const row = await db
    .prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        MIN(CASE WHEN status IN ('pending', 'processing') THEN created_at END) AS oldest_pending_at
      FROM data_quality_remediation_queue
    `)
    .first<QueueMetricRow>();
  const pending = number(row?.pending);
  const processing = number(row?.processing);
  return {
    pending,
    processing,
    resolved: number(row?.resolved),
    failed: number(row?.failed),
    backlog: pending + processing,
    oldestPendingAt: row?.oldest_pending_at || null,
  };
}
