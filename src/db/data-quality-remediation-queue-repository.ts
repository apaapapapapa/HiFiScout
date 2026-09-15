import { RESOLUTION_VERSIONS } from "../catalog/resolution-versions.js";
import { CATEGORY_VERSION_EXPRESSION } from "./resolution-version-sql.js";
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
  targeted_request_key: string;
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

interface TargetedReplayScanRow {
  scan_key: string;
  grado_exact_after_id: number;
  grado_exact_done: number;
  grado_suffix_after_id: number;
  grado_suffix_done: number;
  hifido_line_rca_after_id: number;
  hifido_line_rca_done: number;
  ear_wear_after_id: number;
  ear_wear_done: number;
}

interface TargetedReplayListingRow {
  id: number;
  matched: number;
}

interface TargetedReplayRequestRow {
  listing_product_id: number;
  request_key: string;
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
  scannedCount?: number;
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

function isTargetedReplayTableMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    /no such table:\s*data_quality_targeted_replay_(?:requests|scans)/i.test(error.message)
  );
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
  if (row.targeted_request_key) return `targeted:${row.targeted_request_key}:listing:${row.id}`;
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
  /** Indexed version used with the driving id as the continuation key. */
  readonly cursorVersion: string;
  /** A durable, rule-specific request that only a Worker containing this selector can consume. */
  readonly targetedRequestKey?: string;
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
        CROSS JOIN products p ON p.id = r.listing_product_id`;
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
 * Order is initial priority; each call rotates its starting selector to avoid starvation. A listing
 * behind on two stages is seeded for the first one that claims it in that call.
 */
const STALE_SELECTORS: readonly StaleSelector[] = [
  {
    key: "manufacturer_version",
    ...LISTING_DRIVEN,
    source: listingSource("idx_products_active_manufacturer_version"),
    where: "p.is_active = 1 AND p.manufacturer_resolver_version < ?",
    binds: [RESOLUTION_VERSIONS.manufacturer],
    orderBy: "k.manufacturer_resolver_version, k.id",
    cursorVersion: "p.manufacturer_resolver_version",
    workType: "resolve_manufacturer",
  },
  {
    key: "model_version",
    ...LISTING_DRIVEN,
    source: listingSource("idx_products_active_model_version"),
    where: "p.is_active = 1 AND p.model_resolver_version < ?",
    binds: [RESOLUTION_VERSIONS.model],
    orderBy: "k.model_resolver_version, k.id",
    cursorVersion: "p.model_resolver_version",
    workType: "resolve_model",
  },
  {
    key: "category_version",
    ...LISTING_DRIVEN,
    source: listingSource("idx_products_active_category_version"),
    where: `p.is_active = 1 AND ${CATEGORY_VERSION_EXPRESSION} < ?`,
    binds: [RESOLUTION_VERSIONS.category],
    orderBy: "k.category_classifier_version, k.id",
    cursorVersion: CATEGORY_VERSION_EXPRESSION,
    workType: "classify_category",
  },
  {
    key: "identity_version",
    // The one selector `product_identity_resolutions` drives, so both the id and the version come
    // from that table: they are the columns of `idx_product_identity_resolver_version`, in its order.
    id: "r.listing_product_id",
    identityVersion: "r.identity_resolver_version",
    source: identitySource("idx_product_identity_resolver_version"),
    // Bound identity rows before excluding inactive listings, or an inactive prefix defeats LIMIT.
    where: "r.identity_resolver_version < ?",
    binds: [RESOLUTION_VERSIONS.identity],
    orderBy: "k.identity_resolver_version, k.id",
    cursorVersion: "r.identity_resolver_version",
    workType: "resolve_identity",
  },
  {
    key: "projection_required",
    ...LISTING_DRIVEN,
    source: listingSource("idx_products_remediation_projection_required"),
    where: "p.is_active = 1 AND p.remediation_projection_required = 1",
    binds: [],
    orderBy: "k.id",
    cursorVersion: "0",
    workType: "rebuild_search_entity",
  },
  {
    key: "targeted_replay",
    id: "t.listing_product_id",
    identityVersion: "COALESCE(r.identity_resolver_version, 0)",
    source: `data_quality_targeted_replay_requests t INDEXED BY idx_dq_targeted_replay_listing
        CROSS JOIN products p ON p.id = t.listing_product_id
        LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id`,
    where: "1 = 1",
    binds: [],
    orderBy: "k.id",
    cursorVersion: "0",
    workType: "reprocess_listing",
    targetedRequestKey: "t.request_key",
  },
];

interface TargetedReplayScanDefinition {
  readonly requestKey: string;
  readonly reason: string;
  readonly source: string;
  readonly visitWhere: string;
  readonly matchWhere: string;
}

const TARGETED_REPLAY_SCANS: readonly TargetedReplayScanDefinition[] = [
  {
    requestKey: "0131-grado-gs3000",
    reason: "catalog_identity_and_reviewed_product_type",
    source: "products p INDEXED BY idx_products_manufacturer_id",
    visitWhere: "p.manufacturer_id='grado' AND p.is_active=1",
    matchWhere: `p.normalized_model='GS3000'
      AND NOT EXISTS (
        SELECT 1 FROM product_admin_overrides o
        WHERE o.listing_product_id=p.id
          AND (o.model IS NOT NULL OR o.primary_category_id IS NOT NULL)
      )`,
  },
  {
    requestKey: "0131-grado-gs3000",
    reason: "seller_suffix_and_reviewed_product_type",
    source: "products p INDEXED BY idx_products_admin_shop_cursor",
    visitWhere: "p.shop_key='fujiya-avic' AND p.is_active=1",
    matchWhere: `p.manufacturer_id='grado'
      AND p.normalized_raw_manufacturer='grado'
      AND p.raw_model='GS3000-Classic Series'
      AND NOT EXISTS (
        SELECT 1 FROM product_admin_overrides o
        WHERE o.listing_product_id=p.id
          AND (o.model IS NOT NULL OR o.primary_category_id IS NOT NULL)
      )`,
  },
  {
    requestKey: "0131-hifido-line-rca",
    reason: "reviewed_exact_seller_category",
    source: "products p INDEXED BY idx_products_admin_shop_cursor",
    visitWhere: "p.shop_key='hifido' AND p.is_active=1",
    matchWhere: `p.raw_category='ケーブル ラインRCAケーブル'
      AND NOT EXISTS (
        SELECT 1 FROM product_admin_overrides o
        WHERE o.listing_product_id=p.id AND o.primary_category_id IS NOT NULL
      )`,
  },
  {
    requestKey: "0131-ear-wear-accessory",
    reason: "bare_ear_wear_sale_subject",
    source: "products p INDEXED BY idx_products_product_audit_active",
    visitWhere: "p.is_active=1",
    matchWhere: `(lower(p.title) GLOB '*ear-pad*' OR lower(p.title) GLOB '*ear pad*'
        OR lower(p.title) GLOB '*earpad*' OR lower(p.title) GLOB '*ear-tip*'
        OR lower(p.title) GLOB '*ear tip*' OR lower(p.title) GLOB '*eartip*'
        OR instr(p.title,'イヤーパッド')>0 OR instr(p.title,'イヤーピース')>0)
      AND NOT EXISTS (
        SELECT 1 FROM product_admin_overrides o
        WHERE o.listing_product_id=p.id
          AND (o.model IS NOT NULL OR o.primary_category_id IS NOT NULL)
      )`,
  },
] as const;

/**
 * Turn migration-owned scan signals into per-listing replay requests.
 *
 * Migration 0131 runs before the replacement Worker is deployed. A scan signal is deliberately
 * invisible to the old Worker, so the first new-runtime sweep sees both migration-time rows and
 * writes made in that deployment interval. Each scan is paged by listing id and deleted only after
 * reaching its tail; normal writes made by the new runtime already contain the reviewed rules.
 */
async function materializeTargetedReplayScans(
  db: QueryableDatabase,
  limit: number,
  now: string,
): Promise<void> {
  let scan;
  try {
    scan = await db
      .prepare(`SELECT scan_key,grado_exact_after_id,grado_exact_done,
        grado_suffix_after_id,grado_suffix_done,hifido_line_rca_after_id,hifido_line_rca_done,
        ear_wear_after_id,ear_wear_done
        FROM data_quality_targeted_replay_scans
        WHERE scan_key='0131-grado-gs3000-mit-avt3'`)
      .first<TargetedReplayScanRow>();
  } catch (error) {
    // Historical-schema tests intentionally run current code before migration 0131.
    if (isTargetedReplayTableMissing(error)) return;
    throw error;
  }
  if (!scan) return;

  const afterIds = [
    number(scan.grado_exact_after_id),
    number(scan.grado_suffix_after_id),
    number(scan.hifido_line_rca_after_id),
    number(scan.ear_wear_after_id),
  ];
  const done = [
    number(scan.grado_exact_done) === 1,
    number(scan.grado_suffix_done) === 1,
    number(scan.hifido_line_rca_done) === 1,
    number(scan.ear_wear_done) === 1,
  ];
  let remaining = limit;
  const statements = [];
  for (const [index, definition] of TARGETED_REPLAY_SCANS.entries()) {
    if (done[index] || remaining === 0) continue;
    const rows = await db
      .prepare(`WITH visited AS MATERIALIZED (
          SELECT p.id FROM ${definition.source}
          WHERE ${definition.visitWhere} AND p.id>?
          ORDER BY p.id
          LIMIT ?
        )
        SELECT p.id,CASE WHEN ${definition.matchWhere} THEN 1 ELSE 0 END AS matched
        FROM visited v CROSS JOIN products p ON p.id=v.id
        ORDER BY p.id`)
      .bind(afterIds[index], remaining)
      .all<TargetedReplayListingRow>();
    const visited = rows.results || [];
    const listings = visited.filter((listing) => number(listing.matched) === 1);
    statements.push(
      ...listings.map((listing) =>
        db
          .prepare(`INSERT INTO data_quality_targeted_replay_requests(
          listing_product_id,request_key,reason,created_at
        ) SELECT ?,?,?,? WHERE NOT EXISTS (
          SELECT 1 FROM data_quality_remediation_queue q WHERE q.work_key=?
        ) ON CONFLICT(listing_product_id) DO NOTHING`)
          .bind(
            number(listing.id),
            definition.requestKey,
            definition.reason,
            now,
            `targeted:${definition.requestKey}:listing:${number(listing.id)}`,
          ),
      ),
    );
    if (visited.length < remaining) {
      done[index] = true;
    }
    if (visited.length > 0) afterIds[index] = number(visited[visited.length - 1]?.id);
    remaining -= visited.length;
  }
  const oldState = [
    number(scan.grado_exact_after_id),
    number(scan.grado_exact_done),
    number(scan.grado_suffix_after_id),
    number(scan.grado_suffix_done),
    number(scan.hifido_line_rca_after_id),
    number(scan.hifido_line_rca_done),
    number(scan.ear_wear_after_id),
    number(scan.ear_wear_done),
  ];
  if (done.every(Boolean)) {
    statements.push(
      db
        .prepare(`DELETE FROM data_quality_targeted_replay_scans
          WHERE scan_key=? AND grado_exact_after_id=? AND grado_exact_done=?
            AND grado_suffix_after_id=? AND grado_suffix_done=?
            AND hifido_line_rca_after_id=? AND hifido_line_rca_done=?
            AND ear_wear_after_id=? AND ear_wear_done=?`)
        .bind(scan.scan_key, ...oldState),
    );
  } else {
    statements.push(
      db
        .prepare(`UPDATE data_quality_targeted_replay_scans
          SET grado_exact_after_id=?,grado_exact_done=?,
            grado_suffix_after_id=?,grado_suffix_done=?,
            hifido_line_rca_after_id=?,hifido_line_rca_done=?,
            ear_wear_after_id=?,ear_wear_done=?,updated_at=?
          WHERE scan_key=? AND grado_exact_after_id=? AND grado_exact_done=?
            AND grado_suffix_after_id=? AND grado_suffix_done=?
            AND hifido_line_rca_after_id=? AND hifido_line_rca_done=?
            AND ear_wear_after_id=? AND ear_wear_done=?`)
        .bind(
          afterIds[0],
          Number(done[0]),
          afterIds[1],
          Number(done[1]),
          afterIds[2],
          Number(done[2]),
          afterIds[3],
          Number(done[3]),
          now,
          scan.scan_key,
          ...oldState,
        ),
    );
  }
  await db.batch(statements);
}

/**
 * Put migration-owned replay requests ahead of the ordinary stale-version backlog.
 *
 * A replacement Worker must consume these requests promptly: they describe reviewed corrections
 * whose migration has already reached production. The normal scheduled path intentionally drains
 * its existing queue before rotating stale selectors, so relying on that rotation would starve a
 * targeted request whenever a large version backlog already exists. Keep this probe indexed and
 * bounded, and give the resulting jobs higher priority than ordinary automatic replay work.
 */
export async function seedTargetedDataQualityRemediationQueue(
  db: QueryableDatabase,
  {
    limit = DEFAULT_SEED_LIMIT,
    now = new Date().toISOString(),
  }: { limit?: number; now?: string } = {},
): Promise<SeedRemediationResult> {
  const selectedLimit = bounded(limit, DEFAULT_SEED_LIMIT, MAX_SEED_LIMIT);
  try {
    await materializeTargetedReplayScans(db, selectedLimit, now);
    const rows = await db
      .prepare(`SELECT t.listing_product_id,t.request_key
        FROM data_quality_targeted_replay_requests t INDEXED BY idx_dq_targeted_replay_listing
        WHERE NOT EXISTS (
          SELECT 1 FROM data_quality_remediation_queue q
          WHERE q.work_key='targeted:' || t.request_key || ':listing:' || t.listing_product_id
        )
        ORDER BY t.listing_product_id
        LIMIT ?`)
      .bind(selectedLimit)
      .all<TargetedReplayRequestRow>();
    const candidates = (rows.results || []).map((row) => {
      const listingProductId = number(row.listing_product_id);
      const workKey = `targeted:${row.request_key}:listing:${listingProductId}`;
      return { listingProductId, workKey };
    });
    if (candidates.length) {
      await db.batch(
        candidates.map(({ listingProductId, workKey }) =>
          db
            .prepare(`INSERT INTO data_quality_remediation_queue(
              work_key,work_type,listing_product_id,entity_id,reason,source,status,
              priority,max_attempts,available_at,created_at,updated_at
            ) VALUES (?,'reprocess_listing',?,?,?,'scheduled_sweep','pending',1000,3,?,?,?)
            ON CONFLICT(work_key) DO NOTHING`)
            .bind(
              workKey,
              listingProductId,
              String(listingProductId),
              "migration_targeted_data_quality_remediation",
              now,
              now,
              now,
            ),
        ),
      );
    }
    return {
      selectedCount: candidates.length,
      workKeys: candidates.map(({ workKey }) => workKey),
      scannedCount: candidates.length,
    };
  } catch (error) {
    if (isTargetedReplayTableMissing(error)) {
      return { selectedCount: 0, workKeys: [], scannedCount: 0 };
    }
    throw error;
  }
}

/**
 * The candidate projection, reached through one selector.
 *
 * Only the driving table, predicate, order and work type vary. The work key still carries all four
 * resolver versions whichever selector produced the row, so the same listing reached two ways
 * produces the same key and a version bump anywhere still produces a new one.
 */
function staleCandidateSql(selector: StaleSelector): string {
  return `
      WITH candidates AS MATERIALIZED (
        SELECT
          ${selector.id} AS id,
          p.is_active,
          p.manufacturer_resolver_version,
          p.model_resolver_version,
          ${CATEGORY_VERSION_EXPRESSION} AS category_classifier_version,
          ${selector.identityVersion} AS identity_resolver_version,
          ${selector.targetedRequestKey || "''"} AS targeted_request_key,
          ${selector.cursorVersion} AS cursor_version
        FROM ${selector.source}
        WHERE ${selector.where}
          AND ${selector.cursorVersion === "0" ? `${selector.id} > ?` : `(${selector.cursorVersion}, ${selector.id}) > (?, ?)`}
        ORDER BY ${selector.cursorVersion === "0" ? selector.id : `${selector.cursorVersion}, ${selector.id}`}
        LIMIT ?
      ), keyed AS (
        SELECT
          c.*,
          CASE WHEN c.targeted_request_key <> '' THEN
            'targeted:' || c.targeted_request_key || ':listing:' || c.id
          ELSE
            'auto:${selector.workType}' ||
            ':listing:' || c.id ||
            ':manufacturer:' || c.manufacturer_resolver_version ||
            ':model:' || c.model_resolver_version ||
            ':category:' || c.category_classifier_version ||
            ':identity:' || c.identity_resolver_version
          END AS work_key
        FROM candidates c
      )
      SELECT
        k.id,
        k.is_active,
        k.manufacturer_resolver_version,
        k.model_resolver_version,
        k.category_classifier_version,
        k.identity_resolver_version,
        k.targeted_request_key,
        k.cursor_version,
        EXISTS (
        SELECT 1
        FROM data_quality_remediation_queue q
        WHERE q.work_key = k.work_key
      ) AS queued
      FROM keyed k
      ORDER BY ${selector.orderBy}
    `;
}

interface SeedCursor {
  selector: string;
  version_key: string;
  after_version: number;
  after_id: number;
}

interface SeedWindowRow extends CandidateRow {
  is_active: number;
  cursor_version: number;
  queued: number;
}

/**
 * Bound candidates before probing the queue. Each selector resumes after the last candidate
 * accounted for, including queued rows, and wraps after reaching its tail. A version change resets
 * all positions. Rotation prevents a permanently full early selector from starving other stages.
 * A checkpoint never advances past work that could not be inserted within the seed budget.
 */
export async function seedDataQualityRemediationQueue(
  db: QueryableDatabase,
  {
    limit = DEFAULT_SEED_LIMIT,
    now = new Date().toISOString(),
  }: { limit?: number; now?: string } = {},
): Promise<SeedRemediationResult> {
  const selectedLimit = bounded(limit, DEFAULT_SEED_LIMIT, MAX_SEED_LIMIT);
  await materializeTargetedReplayScans(db, selectedLimit, now);
  const versionKey = JSON.stringify(RESOLUTION_VERSIONS);
  const keys = [...STALE_SELECTORS.map((selector) => selector.key), "rotation"];
  const saved = await db
    .prepare(`SELECT selector, version_key, after_version, after_id
      FROM data_quality_remediation_seed_cursors WHERE selector IN (${keys.map(() => "?").join(",")})`)
    .bind(...keys)
    .all<SeedCursor>();
  const cursors = new Map((saved.results || []).map((cursor) => [cursor.selector, cursor]));
  const save = async (key: string, afterVersion: number, afterId: number) => {
    const old = cursors.get(key);
    if (!old && afterVersion === -1 && afterId === 0) return;
    if (
      old?.version_key === versionKey &&
      old.after_version === afterVersion &&
      old.after_id === afterId
    )
      return;
    await db
      .prepare(`INSERT INTO data_quality_remediation_seed_cursors
      (selector,version_key,after_version,after_id) VALUES (?,?,?,?)
      ON CONFLICT(selector) DO UPDATE SET version_key=excluded.version_key,
        after_version=excluded.after_version,after_id=excluded.after_id
      WHERE data_quality_remediation_seed_cursors.version_key IS ?
        AND data_quality_remediation_seed_cursors.after_version IS ?
        AND data_quality_remediation_seed_cursors.after_id IS ?`)
      .bind(
        key,
        versionKey,
        afterVersion,
        afterId,
        old?.version_key ?? null,
        old?.after_version ?? null,
        old?.after_id ?? null,
      )
      .run();
  };
  const rotation = cursors.get("rotation");
  const start =
    rotation?.version_key === versionKey ? rotation.after_id % STALE_SELECTORS.length : 0;
  const seen = new Set<number>();
  const workKeys: string[] = [];
  let selectedCount = 0;
  let scannedCount = 0;
  let next = start;
  for (
    let offset = 0;
    offset < STALE_SELECTORS.length && selectedCount < selectedLimit;
    offset += 1
  ) {
    const index = (start + offset) % STALE_SELECTORS.length;
    const selector = STALE_SELECTORS[index]!;
    const old = cursors.get(selector.key);
    const valid = old?.version_key === versionKey;
    let afterVersion = valid ? old.after_version : -1;
    let afterId = valid ? old.after_id : 0;
    let rows;
    try {
      rows = await db
        .prepare(staleCandidateSql(selector))
        .bind(
          ...selector.binds,
          ...(selector.cursorVersion === "0" ? [afterId] : [afterVersion, afterId]),
          selectedLimit,
        )
        .all<SeedWindowRow>();
    } catch (error) {
      // Historical-migration tests intentionally run current code against a schema from before
      // 0131. Production creates the table before deploying this selector, while skipping only
      // this exact missing-table case preserves that useful compatibility harness.
      if (selector.key === "targeted_replay" && isTargetedReplayTableMissing(error)) continue;
      throw error;
    }
    const window = rows.results || [];
    scannedCount += window.length;
    let visited = 0;
    for (const row of window) {
      if (selectedCount >= selectedLimit) break;
      const id = number(row.id);
      if ((row.is_active || selector.key === "targeted_replay") && !row.queued && !seen.has(id)) {
        const workKey = automaticWorkKey({ row, workType: selector.workType });
        const inserted = await enqueueDataQualityRemediation(db, {
          workKey,
          workType: selector.workType,
          listingProductId: id,
          entityId: String(id),
          reason: "automatic_data_quality_remediation",
          source: "scheduled_sweep",
          now,
        });
        seen.add(id);
        selectedCount += 1;
        if (inserted) workKeys.push(workKey);
      }
      afterVersion = number(row.cursor_version);
      afterId = id;
      visited += 1;
    }
    if (visited === window.length && window.length < selectedLimit) {
      afterVersion = -1;
      afterId = 0;
    }
    await save(selector.key, afterVersion, afterId);
    next = (index + 1) % STALE_SELECTORS.length;
  }
  await save("rotation", -1, next);
  return { selectedCount, workKeys, scannedCount };
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
  targetedJob?: Pick<DataQualityRemediationJob, "listingProductId" | "workKey">,
): Promise<void> {
  const resolve = db
    .prepare(`
      UPDATE data_quality_remediation_queue
      SET status = 'resolved', resolved_at = ?, claimed_at = NULL, lease_expires_at = NULL,
          last_error = '', updated_at = ?
      WHERE id = ? AND status = 'processing'
    `)
    .bind(resolvedAt, resolvedAt, jobId);
  if (!targetedJob?.workKey.startsWith("targeted:") || !targetedJob.listingProductId) {
    await resolve.run();
    return;
  }
  await db.batch([
    db
      .prepare(`
      DELETE FROM data_quality_targeted_replay_requests
      WHERE listing_product_id = ?
        AND 'targeted:' || request_key || ':listing:' || listing_product_id = ?
    `)
      .bind(targetedJob.listingProductId, targetedJob.workKey),
    resolve,
  ]);
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
