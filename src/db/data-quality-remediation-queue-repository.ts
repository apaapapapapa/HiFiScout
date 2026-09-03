import { RESOLUTION_VERSIONS } from "../catalog/resolution-versions.js";
import { firstMeasured } from "./read-accounting.js";
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
  manufacturer_resolver_version: number;
  model_resolver_version: number;
  category_classifier_version: number;
  identity_resolver_version: number;
}

/** A candidate plus the selector that found it, which is what it is owed. */
interface Candidate {
  readonly row: CandidateRow;
  readonly workType: DataQualityRemediationWorkType;
}

interface FullRebuildRow {
  id: number;
}

interface StatusCountRow {
  count: number | null;
  oldest_created_at: string | null;
}

/**
 * The outstanding work, and nothing about work that has finished.
 *
 * This is what the scheduled sweep needs: whether there is a backlog, how old it is, and whether a
 * lease is out. None of it grows with retained history, which is the point -- see
 * {@link dataQualityRemediationActiveQueueMetrics}.
 */
export interface ActiveQueueMetrics {
  pending: number;
  processing: number;
  backlog: number;
  oldestPendingAt: string | null;
}

export interface QueueMetrics extends ActiveQueueMetrics {
  resolved: number;
  failed: number;
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

/** Must stay identical to the `work_key` the selector's SQL builds, which is what dedupes work. */
function automaticWorkKey({ row, workType }: Candidate): string {
  return [
    "auto",
    workType,
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
 * One indexed way into the stale set, bounded by its own LIMIT.
 *
 * Staleness used to be a single disjunction over ten columns. No index can serve a disjunction, so
 * every five-minute tick read every listing. Splitting it gives each condition its own selector and
 * its own index — but an index is only half of it: the selector's `ORDER BY` has to be the order its
 * index already delivers, or the plan collects every matching row into a temp b-tree before the
 * LIMIT can discard them, and the tick is once again proportional to the backlog rather than to the
 * page it is allowed to take.
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
  /** Must match what `source`'s index already yields, so LIMIT stops the walk. */
  readonly orderBy: string;
  /** What the selected listing is owed. The selector *is* the reason, so it names it. */
  readonly workType: DataQualityRemediationWorkType;
  /**
   * Listing id, as the *driving* table spells it.
   *
   * It has to come from the table the index is on, or the ordering the index delivers is one SQLite
   * cannot connect to the `ORDER BY` and it sorts instead. `p.id` and `r.listing_product_id` are the
   * same value — the join is on them — but only one of them is a column of the driving index.
   */
  readonly id: string;
  /** Same reasoning: a `COALESCE` over an indexed column is an expression, and cannot be ordered on. */
  readonly identityVersion: string;
}

/** Reached through `products`, so the identity row may be absent and its version defaults. */
const LISTING_DRIVEN = {
  id: "p.id",
  identityVersion: "COALESCE(r.identity_resolver_version, 0)",
} as const;

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
 * The two things that make a listing stale, one selector per stage.
 *
 * Both are *signals*: a resolver version behind the current one, and the projection dirty flag that
 * a failed downstream refresh leaves behind. Both are also self-clearing, so a drained stage costs a
 * seek that finds nothing.
 *
 * A resolution *result* — still-unresolved manufacturer, still-unclassified category, still-
 * unresolved identity, missing identity row — is deliberately not here, though it used to be. It is
 * not a signal: replaying the same resolver version over the same listing produces the same result,
 * so those selectors walked the whole persistent unresolved catalog every tick to enqueue work whose
 * outcome was already known, and then to find nothing at all once the deterministic keys were
 * queued. What actually changes an outcome is a version bump, which the selectors below catch, or a
 * dependency change, and every dependency drives its own bounded, cursor-restartable replay:
 * `reprocessManufacturerAliasListings` on alias verification, `reprocessPendingCatalogRemediation`
 * on catalog verification, and `reclassifyProductsFromKnowledgeCatalog`, which sets
 * `remediation_projection_required` and so arrives back here through the projection selector.
 * Re-running everything regardless stays available as the explicit, paged
 * `enqueueFullDataQualityRebuild`.
 *
 * Order is priority: a listing behind on two stages is seeded for the first one that claims it.
 */
const STALE_SELECTORS: readonly StaleSelector[] = [
  {
    key: "manufacturer_version",
    ...LISTING_DRIVEN,
    source: listingSource("idx_products_active_manufacturer_version"),
    where: "p.is_active = 1 AND p.manufacturer_resolver_version < ?",
    binds: [RESOLUTION_VERSIONS.manufacturer],
    orderBy: "k.manufacturer_resolver_version, k.id",
    workType: "resolve_manufacturer",
  },
  {
    key: "model_version",
    ...LISTING_DRIVEN,
    source: listingSource("idx_products_active_model_version"),
    where: "p.is_active = 1 AND p.model_resolver_version < ?",
    binds: [RESOLUTION_VERSIONS.model],
    orderBy: "k.model_resolver_version, k.id",
    workType: "resolve_model",
  },
  {
    key: "category_version",
    ...LISTING_DRIVEN,
    source: listingSource("idx_products_active_category_version"),
    where: `p.is_active = 1 AND ${CATEGORY_VERSION_EXPRESSION} < ?`,
    binds: [RESOLUTION_VERSIONS.category],
    orderBy: "k.category_classifier_version, k.id",
    workType: "classify_category",
  },
  {
    key: "identity_version",
    // The one selector `product_identity_resolutions` drives, so both the id and the version come
    // from that table: they are the columns of `idx_product_identity_resolver_version`, in its order.
    id: "r.listing_product_id",
    identityVersion: "r.identity_resolver_version",
    source: identitySource("idx_product_identity_resolver_version"),
    where: "p.is_active = 1 AND r.identity_resolver_version < ?",
    binds: [RESOLUTION_VERSIONS.identity],
    orderBy: "k.identity_resolver_version, k.id",
    workType: "resolve_identity",
  },
  {
    key: "projection_required",
    ...LISTING_DRIVEN,
    source: listingSource("idx_products_remediation_projection_required"),
    where: "p.is_active = 1 AND p.remediation_projection_required = 1",
    binds: [],
    orderBy: "k.id",
    workType: "rebuild_search_entity",
  },
];

/**
 * The candidate projection, reached through one selector.
 *
 * Only the driving table, predicate, order and work type vary. The work key still carries all four
 * resolver versions whichever selector produced the row, so the same listing reached two ways
 * produces the same key and a version bump anywhere still produces a new one.
 */
function staleCandidateSql(selector: StaleSelector): string {
  return `
      WITH candidates AS (
        SELECT
          ${selector.id} AS id,
          p.manufacturer_resolver_version,
          p.model_resolver_version,
          ${CATEGORY_VERSION_EXPRESSION} AS category_classifier_version,
          ${selector.identityVersion} AS identity_resolver_version
        FROM ${selector.source}
        WHERE ${selector.where}
      ), keyed AS (
        SELECT
          c.*,
          'auto:${selector.workType}' ||
          ':listing:' || c.id ||
          ':manufacturer:' || c.manufacturer_resolver_version ||
          ':model:' || c.model_resolver_version ||
          ':category:' || c.category_classifier_version ||
          ':identity:' || c.identity_resolver_version AS work_key
        FROM candidates c
      )
      SELECT
        k.id,
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
      ORDER BY ${selector.orderBy}
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
  const candidates: Candidate[] = [];
  // Every selector runs, and each is asked for at most one page, so a tick reads a fixed number of
  // bounded index seeks however far behind the catalog is. Stopping early once the budget is full
  // would save four seeks and cost the harness its view of the other four plans — and would let a
  // long backfill guarantee that the later stages are never even looked at.
  //
  // Pages are kept in selector order, which is the work-type priority the single CASE expression
  // used to encode: a listing behind on two stages is seeded for the first stage that claims it.
  for (const selector of STALE_SELECTORS) {
    const rows = await db
      .prepare(staleCandidateSql(selector))
      .bind(...selector.binds, selectedLimit)
      .all<CandidateRow>();
    for (const row of rows.results || []) {
      const id = number(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push({ row, workType: selector.workType });
    }
  }

  const selected = candidates.slice(0, selectedLimit);
  const workKeys: string[] = [];
  for (const candidate of selected) {
    const { row } = candidate;
    const workKey = automaticWorkKey(candidate);
    const inserted = await enqueueDataQualityRemediation(db, {
      workKey,
      workType: candidate.workType,
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

/**
 * Counts one status, through the partial index that exists for it.
 *
 * One statement per status rather than one `CASE` aggregate over all of them. The single-statement
 * form reads the whole table -- there is no index that can answer `SUM(CASE WHEN status = ...)`
 * across every status at once -- so it costs the entire retained history to report a backlog of
 * two. Even `WHERE status IN ('pending', 'processing')` cannot be served: the two partial indexes
 * are separate objects and the planner falls back to a scan plus a temporary b-tree for the grouping.
 * Statement count is the cheaper thing to spend here.
 *
 * `firstMeasured` rather than `first` so the rows are visible to the D1 read accounting. `first()`
 * carries no `meta`, which is how a query that reads the whole table reported nothing at all.
 */
async function countStatus(
  db: QueryableDatabase,
  status: DataQualityRemediationStatus,
): Promise<number> {
  const row = await firstMeasured<{ count: number | null }>(
    db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM data_quality_remediation_queue
        WHERE status = ?
      `)
      .bind(status),
  );
  return number(row?.count);
}

/**
 * The same count, plus how long the oldest row of that status has been waiting.
 *
 * Kept separate from {@link countStatus} because the two are not the same query to SQLite. No
 * partial index carries `created_at`, so asking for it turns a covering index walk into one that
 * fetches every matching base-table row: measured on the retained resolved history at 100k rows,
 * 1.297 ms covering against 12.792 ms not. That is worth paying where the answer is used and where
 * the set is the backlog; it is pure waste on a terminal status, whose age nothing reads.
 */
async function countStatusWithAge(
  db: QueryableDatabase,
  status: DataQualityRemediationStatus,
): Promise<StatusCountRow> {
  const row = await firstMeasured<StatusCountRow>(
    db
      .prepare(`
        SELECT COUNT(*) AS count, MIN(created_at) AS oldest_created_at
        FROM data_quality_remediation_queue
        WHERE status = ?
      `)
      .bind(status),
  );
  return { count: number(row?.count), oldest_created_at: row?.oldest_created_at || null };
}

function earliest(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

/**
 * Queue state for the scheduled sweep: outstanding work only.
 *
 * The sweep that calls this claims a handful of jobs and resolves them. It used to finish by
 * recomputing lifetime totals over the whole queue -- tens of thousands of terminal rows read to
 * report that one job had been handled. Those totals are not what the sweep decides anything with,
 * and its own per-run counts (`resolved`, `failed`, `retried`) already say what the run did.
 *
 * Reads scale with the backlog, not with retained history. Lifetime totals live on
 * {@link dataQualityRemediationQueueMetrics}, which the admin status endpoint calls on demand.
 */
export async function dataQualityRemediationActiveQueueMetrics(
  db: QueryableDatabase,
): Promise<ActiveQueueMetrics> {
  const [pending, processing] = await Promise.all([
    countStatusWithAge(db, "pending"),
    countStatusWithAge(db, "processing"),
  ]);
  return {
    pending: number(pending.count),
    processing: number(processing.count),
    backlog: number(pending.count) + number(processing.count),
    // Both states are outstanding work, so the oldest of either is the age of the backlog.
    oldestPendingAt: earliest(pending.oldest_created_at, processing.oldest_created_at),
  };
}

/**
 * Lifetime queue totals, including terminal history.
 *
 * On-demand only -- the admin data-quality status endpoint. Counting `resolved` is inherently
 * proportional to the retained resolved history; it is served by the partial resolved index as a
 * covering read, so it walks index entries rather than table rows, but it is not bounded and must
 * not be put on a scheduled path. Use {@link dataQualityRemediationActiveQueueMetrics} there.
 */
export async function dataQualityRemediationQueueMetrics(
  db: QueryableDatabase,
): Promise<QueueMetrics> {
  const [active, resolved, failed] = await Promise.all([
    dataQualityRemediationActiveQueueMetrics(db),
    countStatus(db, "resolved"),
    countStatus(db, "failed"),
  ]);
  return { ...active, resolved, failed };
}
