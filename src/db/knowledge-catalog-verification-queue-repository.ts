import { firstMeasured } from "./read-accounting.js";
import type {
  CompleteKnowledgeCatalogVerificationJobInput,
  KnowledgeCatalogVerificationJob,
  KnowledgeCatalogVerificationJobRow,
  KnowledgeCatalogVerificationJobSpec,
  KnowledgeCatalogVerificationQueueStatus,
  KnowledgeCatalogVerificationRunStats,
  ProductClassificationStats,
  QueryableDatabase,
} from "./types.js";

const WRITE_BATCH_SIZE = 50;

/**
 * Run-scoped selectors seek `(run_id, status IN live)` and `(run_id, job_type IN targets, status)`
 * instead of filtering a run's whole history. `job_type <> 'finalize'` and an OR across statuses
 * cannot seek past `run_id`, so every claim re-read the run's completed jobs as well; with one
 * claim per job that made a run quadratic in its size. The schema's CHECK limits `job_type` to
 * these two plus `finalize`.
 */
const LIVE_JOB_STATUSES = "'queued', 'processing', 'retrying'";
const TARGET_JOB_TYPES = "'candidate', 'product_recheck'";
/**
 * Waiting jobs: the ones a claim can take once they are due. Must stay textually identical to the
 * WHERE clause of `idx_knowledge_catalog_verification_jobs_run_host_waiting` (migration 0138), or
 * SQLite cannot prove a query implies it and reads the run's live range instead.
 */
const WAITING_JOB_STATUSES = "'queued', 'retrying'";

/*
 * The run claim and wake-state reads below bind `?1` to the run and `?2` to the observation time.
 * Neither walks the run's live jobs. Targets cluster on a few manufacturer domains and the
 * dominant one is usually paced between requests, so a per-job walk made every claim -- and the
 * wake-state read after each empty one -- visit the whole live run, which made a run quadratic in
 * its size.
 *
 * - `run_hosts` enumerates the distinct domains that still have a waiting job, one partial-index
 *   seek each (a recursive skip scan; D1 also counts each row the recursion reads back). Each
 *   statement references it once, joined to the domain's active lease: no lease row means nobody
 *   holds the domain at `?2` (an empty hostname is never leased), and a `0` holder is the pacing
 *   gap a release leaves.
 * - A domain's waiting jobs sit in the partial index in `(available_at, id)` order. For a job with
 *   an availability that is the claim order `COALESCE(available_at, enqueued_at), id`, and every
 *   due job precedes every job not yet due, so the first entry at or before `?2` is the domain's
 *   earliest due job.
 * - The queue never writes a waiting job without an availability, nor a queued one that becomes
 *   available after its enqueue. Both are still read, through their own normally empty seeks, so
 *   the selectors stay exact for every stored state rather than for the states the consumer writes.
 * - D1 rejects a compound SELECT of more than five terms; none here has more than four.
 */

/** The finalizer is eligible only once no target of the run is live: one existence seek. */
const NO_LIVE_TARGETS = `NOT EXISTS (
  SELECT 1
  FROM knowledge_catalog_verification_jobs
  WHERE run_id = ?1
    AND job_type IN (${TARGET_JOB_TYPES})
    AND status IN (${LIVE_JOB_STATUSES})
)`;

/** Whether `alias` may be considered at all: the finalizer waits behind every live target. */
function gateOpenFor(alias: string): string {
  return `(${alias}.job_type <> 'finalize' OR ${NO_LIVE_TARGETS})`;
}

const RUN_HOSTS_CTE = `
  run_hosts(hostname) AS (
    SELECT MIN(hostname)
    FROM knowledge_catalog_verification_jobs
    WHERE run_id = ?1 AND status IN (${WAITING_JOB_STATUSES})
    UNION ALL
    SELECT (
      SELECT MIN(later.hostname)
      FROM knowledge_catalog_verification_jobs later
      WHERE later.run_id = ?1
        AND later.status IN (${WAITING_JOB_STATUSES})
        AND later.hostname > run_hosts.hostname
    )
    FROM run_hosts
    WHERE run_hosts.hostname IS NOT NULL
  )`;

/** Every enumerated domain, with `domain_lease` NULL unless someone holds it at `?2`. */
const RUN_HOSTS_WITH_ACTIVE_LEASE = `
  FROM run_hosts
  LEFT JOIN knowledge_catalog_verification_domain_leases domain_lease
    ON domain_lease.hostname = run_hosts.hostname
   AND run_hosts.hostname <> ''
   AND domain_lease.leased_until > ?2
  WHERE run_hosts.hostname IS NOT NULL`;

/** The domain's due waiting jobs the run may take, in claim order from the partial index. */
const DUE_WAITING_JOBS_OF_HOST = `
  FROM knowledge_catalog_verification_jobs due
  WHERE due.run_id = ?1
    AND due.hostname = run_hosts.hostname
    AND due.status IN (${WAITING_JOB_STATUSES})
    AND due.available_at <= ?2
    AND ${gateOpenFor("due")}`;

interface VerificationRunStatsRow {
  target_jobs: number | null;
  candidate_jobs: number | null;
  product_recheck_jobs: number | null;
  queued: number | null;
  processing: number | null;
  retrying: number | null;
  completed: number | null;
  dead_letter: number | null;
  source_attempts: number | null;
  promoted: number | null;
  rechecked: number | null;
  verified: number | null;
  not_found: number | null;
  ambiguous: number | null;
  unsupported: number | null;
  error: number | null;
  oldest_pending_at: string | null;
}

interface VerificationQueueBatchRow {
  queued?: number | null;
  processing?: number | null;
  retrying?: number | null;
  dead_letter?: number | null;
  oldest_pending_at?: string | null;
  run_id?: number;
}

interface VerificationRunWakeStateRow {
  outstanding_jobs?: number | null;
  next_available_at?: string | null;
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + Math.max(1, Number(seconds) || 1) * 1000).toISOString();
}

function addMilliseconds(iso: string, milliseconds: number): string {
  return new Date(new Date(iso).getTime() + Math.max(0, Number(milliseconds) || 0)).toISOString();
}

async function runBatches(db: QueryableDatabase, statements: D1PreparedStatement[]): Promise<void> {
  for (let index = 0; index < statements.length; index += WRITE_BATCH_SIZE) {
    await db.batch(statements.slice(index, index + WRITE_BATCH_SIZE));
  }
}

function number(value: unknown): number {
  return Number(value || 0);
}

function jobFromRow(
  row: KnowledgeCatalogVerificationJobRow | null | undefined,
): KnowledgeCatalogVerificationJob | null {
  if (!row) return null;
  return {
    id: number(row.id),
    runId: number(row.run_id),
    jobKey: row.job_key,
    jobType: row.job_type,
    targetId: row.target_id == null ? null : number(row.target_id),
    manufacturerId: row.manufacturer_id || "",
    hostname: row.hostname || "",
    status: row.status,
    outcome: row.outcome || "",
    deliveryAttempts: number(row.delivery_attempts),
    sourceAttempts: number(row.source_attempts),
    promoted: number(row.promoted),
    rechecked: number(row.rechecked),
    enqueuedAt: row.enqueued_at,
    availableAt: row.available_at,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    finishedAt: row.finished_at,
    lastMessage: row.last_message || "",
    payloadJson: row.payload_json || "",
  };
}

export async function createKnowledgeCatalogVerificationJobs(
  db: QueryableDatabase,
  runId: number,
  jobs: readonly KnowledgeCatalogVerificationJobSpec[],
  enqueuedAt: string,
): Promise<KnowledgeCatalogVerificationJob[]> {
  const statements = jobs.map((job) =>
    db
      .prepare(`
        INSERT INTO knowledge_catalog_verification_jobs (
          run_id, job_key, job_type, target_id, manufacturer_id, hostname, status,
          enqueued_at, available_at, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
        ON CONFLICT(job_key) DO NOTHING
      `)
      .bind(
        runId,
        job.jobKey,
        job.jobType,
        job.targetId ?? null,
        job.manufacturerId || "",
        job.hostname || "",
        enqueuedAt,
        enqueuedAt,
        job.payloadJson,
        enqueuedAt,
        enqueuedAt,
      ),
  );
  await runBatches(db, statements);
  const result = await db
    .prepare(`
      SELECT *
      FROM knowledge_catalog_verification_jobs
      WHERE run_id = ?
      ORDER BY id
    `)
    .bind(runId)
    .all<KnowledgeCatalogVerificationJobRow>();
  return (result.results || [])
    .map((row) => jobFromRow(row))
    .filter((job): job is KnowledgeCatalogVerificationJob => job !== null);
}

/**
 * Atomically claims one due job selected from a run.
 *
 * Source jobs are preferred and a finalizer is invisible until every source job is terminal. An
 * active domain lease also removes that hostname from the candidate set, allowing another domain
 * in the same run to make progress without violating source pacing.
 *
 * The winner is chosen in the original order from a short candidate list that provably contains
 * it: each free domain's earliest due waiting job, which is eligible as it stands; each held
 * domain's lease holder, the only one of its waiting jobs that can be; the run's processing jobs
 * whose job lease has lapsed; and any waiting job without an availability. All but the first are
 * re-checked against the original eligibility predicate. Among eligible jobs the finalizer key is
 * constant -- the finalizer is eligible only once no target is live -- so a domain's earliest due
 * job is its best. A held domain costs one lease read however many of the run's jobs it owns, and
 * a claim's reads follow the run's domains rather than its live jobs.
 */
export async function claimNextKnowledgeCatalogVerificationJobForRun(
  db: QueryableDatabase,
  runId: number,
  claimedAt: string,
  leaseSeconds: number,
): Promise<KnowledgeCatalogVerificationJob | null> {
  // A selection can lose its conditional claim to another duplicate wake-up. Retry a small,
  // bounded number of times so the invocation can pick a different job instead of spinning.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const selected = await firstMeasured<{ id?: number | null }>(
      db
        .prepare(`
        WITH RECURSIVE ${RUN_HOSTS_CTE},
        candidate(id, eligible) AS (
          SELECT CASE
                   WHEN domain_lease.hostname IS NULL THEN (
                     SELECT due.id
                     ${DUE_WAITING_JOBS_OF_HOST}
                     ORDER BY due.available_at, due.id
                     LIMIT 1
                   )
                   ELSE domain_lease.job_id
                 END,
                 domain_lease.hostname IS NULL
          ${RUN_HOSTS_WITH_ACTIVE_LEASE}
          UNION ALL
          SELECT id, 0
          FROM knowledge_catalog_verification_jobs
          WHERE run_id = ?1
            AND status = 'processing'
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?2)
          UNION ALL
          SELECT id, 0
          FROM knowledge_catalog_verification_jobs
          WHERE run_id = ?1 AND status IN (${WAITING_JOB_STATUSES}) AND available_at IS NULL
        )
        SELECT job.id
        FROM candidate
        CROSS JOIN knowledge_catalog_verification_jobs job ON job.id = candidate.id
        WHERE candidate.eligible
          OR (
            job.run_id = ?1
            AND job.status IN (${LIVE_JOB_STATUSES})
            AND (
              (job.status IN ('queued', 'retrying')
                AND (job.available_at IS NULL OR job.available_at <= ?2))
              OR (job.status = 'processing'
                AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= ?2))
            )
            AND ${gateOpenFor("job")}
            AND (
              job.hostname = ''
              OR NOT EXISTS (
                SELECT 1
                FROM knowledge_catalog_verification_domain_leases domain_lease
                WHERE domain_lease.hostname = job.hostname
                  AND domain_lease.leased_until > ?2
                  AND domain_lease.job_id <> job.id
              )
            )
          )
        ORDER BY CASE WHEN job.job_type = 'finalize' THEN 1 ELSE 0 END,
                 COALESCE(job.available_at, job.enqueued_at),
                 job.id
        LIMIT 1
      `)
        .bind(runId, claimedAt),
    );
    const jobId = number(selected?.id);
    if (!jobId) return null;
    const claimed = await claimKnowledgeCatalogVerificationJob(db, jobId, claimedAt, leaseSeconds);
    if (claimed) return claimed;
  }
  return null;
}

export interface KnowledgeCatalogVerificationRunWakeState {
  outstandingJobs: number;
  /** Earliest time another job can be claimed, or `null` after the run becomes terminal. */
  nextAvailableAt: string | null;
}

/**
 * The earliest time each eligible live job may next be claimed, as one row per contribution:
 *
 * - a processing job: its job lease expiry (`?2` when it has none);
 * - a retrying job not yet due: its availability -- only the earliest one can be the minimum;
 * - a domain with a due waiting job: `?2` while the domain is free or one of those jobs holds it,
 *   because a job is never delayed by its own lease, and otherwise the domain's lease expiry. That
 *   is the per-job value of each such job collapsed to its minimum: one existence seek beside the
 *   lease, plus the holder by id while the domain is held;
 * - any other waiting job -- queued but available only later, or without an availability -- with
 *   the former per-job `CASE` applied to it directly.
 *
 * The minimum over these is exactly the minimum of the former per-job `CASE` over every eligible
 * live job. It is `NULL` precisely when the run has no live job left: while any job is live one
 * is eligible, because the finalizer becomes eligible as soon as no target is live.
 */
const RUN_WAKE_AT_CTE = `
  wake_at(at) AS (
    SELECT COALESCE(job.lease_expires_at, ?2)
    FROM knowledge_catalog_verification_jobs job
    WHERE job.run_id = ?1 AND job.status = 'processing' AND ${gateOpenFor("job")}
    UNION ALL
    SELECT (
      SELECT job.available_at
      FROM knowledge_catalog_verification_jobs job
      WHERE job.run_id = ?1
        AND job.status = 'retrying'
        AND job.available_at > ?2
        AND ${gateOpenFor("job")}
      ORDER BY job.available_at
      LIMIT 1
    )
    UNION ALL
    SELECT CASE
             WHEN NOT EXISTS (SELECT 1 ${DUE_WAITING_JOBS_OF_HOST}) THEN NULL
             WHEN domain_lease.hostname IS NULL
               OR EXISTS (SELECT 1 ${DUE_WAITING_JOBS_OF_HOST} AND due.id = domain_lease.job_id)
               THEN ?2
             ELSE domain_lease.leased_until
           END
    ${RUN_HOSTS_WITH_ACTIVE_LEASE}
    UNION ALL
    SELECT CASE
             WHEN job.hostname <> ''
               AND domain_lease.leased_until > ?2
               AND domain_lease.job_id <> job.id THEN domain_lease.leased_until
             ELSE ?2
           END
    FROM (
      SELECT id
      FROM knowledge_catalog_verification_jobs
      WHERE run_id = ?1 AND status = 'queued' AND available_at > ?2
      UNION ALL
      SELECT id
      FROM knowledge_catalog_verification_jobs
      WHERE run_id = ?1 AND status IN (${WAITING_JOB_STATUSES}) AND available_at IS NULL
    ) AS unscheduled
    CROSS JOIN knowledge_catalog_verification_jobs job ON job.id = unscheduled.id
    LEFT JOIN knowledge_catalog_verification_domain_leases domain_lease
      ON domain_lease.hostname = job.hostname
    WHERE ${gateOpenFor("job")}
  )`;

/**
 * When the run can next make progress, or `null` once it has no live job.
 *
 * This is the wake state without its outstanding-job count, for the in-invocation wait after an
 * empty claim: it costs a few seeks per domain, where the count costs one index entry per live
 * job. `null` here is equivalent to `outstandingJobs === 0` in the full wake state.
 */
export async function knowledgeCatalogVerificationRunNextAvailableAt(
  db: QueryableDatabase,
  runId: number,
  now: string,
): Promise<string | null> {
  const row = await firstMeasured<VerificationRunWakeStateRow>(
    db
      .prepare(`
      WITH RECURSIVE ${RUN_HOSTS_CTE}, ${RUN_WAKE_AT_CTE}
      SELECT MIN(at) AS next_available_at
      FROM wake_at
    `)
      .bind(runId, now),
  );
  return row?.next_available_at || null;
}

/**
 * The run's queued, processing and retrying jobs, the finalizer included.
 *
 * Exact, so it reads one index entry per live job; callers that only need to know whether
 * anything is outstanding use {@link knowledgeCatalogVerificationRunNextAvailableAt} instead.
 */
export async function knowledgeCatalogVerificationRunOutstandingJobs(
  db: QueryableDatabase,
  runId: number,
): Promise<number> {
  const row = await firstMeasured<VerificationRunWakeStateRow>(
    db
      .prepare(`
      SELECT COUNT(*) AS outstanding_jobs
      FROM knowledge_catalog_verification_jobs
      WHERE run_id = ? AND status IN (${LIVE_JOB_STATUSES})
    `)
      .bind(runId),
  );
  return number(row?.outstanding_jobs);
}

/** What a bounded wake invocation should do after its current slice. */
export async function knowledgeCatalogVerificationRunWakeState(
  db: QueryableDatabase,
  runId: number,
  now: string,
): Promise<KnowledgeCatalogVerificationRunWakeState> {
  const row = await firstMeasured<VerificationRunWakeStateRow>(
    db
      .prepare(`
      WITH RECURSIVE ${RUN_HOSTS_CTE}, ${RUN_WAKE_AT_CTE}
      SELECT
        (
          SELECT COUNT(*)
          FROM knowledge_catalog_verification_jobs
          WHERE run_id = ?1 AND status IN (${LIVE_JOB_STATUSES})
        ) AS outstanding_jobs,
        MIN(at) AS next_available_at
      FROM wake_at
    `)
      .bind(runId, now),
  );
  return {
    outstandingJobs: number(row?.outstanding_jobs),
    nextAvailableAt: row?.next_available_at || null,
  };
}

export async function claimKnowledgeCatalogVerificationJob(
  db: QueryableDatabase,
  jobId: number,
  claimedAt: string,
  leaseSeconds: number,
): Promise<KnowledgeCatalogVerificationJob | null> {
  const leaseExpiresAt = addSeconds(claimedAt, leaseSeconds);
  const result = await db
    .prepare(`
      UPDATE knowledge_catalog_verification_jobs
      SET status = 'processing',
          delivery_attempts = delivery_attempts + 1,
          claimed_at = ?,
          lease_expires_at = ?,
          updated_at = ?
      WHERE id = ?
        AND (
          (status IN ('queued', 'retrying') AND (available_at IS NULL OR available_at <= ?))
          OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
    `)
    .bind(claimedAt, leaseExpiresAt, claimedAt, jobId, claimedAt, claimedAt)
    .run();
  if (number(result?.meta?.changes) === 0) return null;
  const row = await firstMeasured<KnowledgeCatalogVerificationJobRow>(
    db.prepare("SELECT * FROM knowledge_catalog_verification_jobs WHERE id = ?").bind(jobId),
  );
  return jobFromRow(row);
}

export async function getKnowledgeCatalogVerificationJob(
  db: QueryableDatabase,
  jobId: number,
): Promise<KnowledgeCatalogVerificationJob | null> {
  const row = await db
    .prepare("SELECT * FROM knowledge_catalog_verification_jobs WHERE id = ?")
    .bind(jobId)
    .first<KnowledgeCatalogVerificationJobRow>();
  return jobFromRow(row);
}

export async function deadLetterOutstandingKnowledgeCatalogVerificationJobsForRun(
  db: QueryableDatabase,
  runId: number,
  finishedAt: string,
  message: unknown,
): Promise<number> {
  const result = await db
    .prepare(`
      UPDATE knowledge_catalog_verification_jobs
      SET status = 'dead_letter', outcome = 'error', finished_at = ?,
          available_at = NULL, claimed_at = NULL, lease_expires_at = NULL,
          last_message = ?, updated_at = ?
      WHERE run_id = ?
        AND status IN ('queued', 'processing', 'retrying')
    `)
    .bind(finishedAt, String(message || "failed_run_recovery").slice(0, 1000), finishedAt, runId)
    .run();
  return number(result?.meta?.changes);
}

export async function incrementKnowledgeCatalogVerificationSourceAttempt(
  db: QueryableDatabase,
  jobId: number,
  attemptedAt: string,
): Promise<number> {
  await db
    .prepare(`
      UPDATE knowledge_catalog_verification_jobs
      SET source_attempts = source_attempts + 1, updated_at = ?
      WHERE id = ? AND status = 'processing'
    `)
    .bind(attemptedAt, jobId)
    .run();
  const row = await db
    .prepare("SELECT source_attempts FROM knowledge_catalog_verification_jobs WHERE id = ?")
    .bind(jobId)
    .first<Pick<KnowledgeCatalogVerificationJobRow, "source_attempts">>();
  return number(row?.source_attempts);
}

export async function retryKnowledgeCatalogVerificationJob(
  db: QueryableDatabase,
  jobId: number,
  availableAt: string,
  message: unknown,
  updatedAt: string,
): Promise<void> {
  await db
    .prepare(`
      UPDATE knowledge_catalog_verification_jobs
      SET status = 'retrying',
          available_at = ?,
          claimed_at = NULL,
          lease_expires_at = NULL,
          last_message = ?,
          updated_at = ?
      WHERE id = ? AND status = 'processing'
    `)
    .bind(availableAt, String(message || "").slice(0, 1000), updatedAt, jobId)
    .run();
}

export async function completeKnowledgeCatalogVerificationJob(
  db: QueryableDatabase,
  jobId: number,
  {
    outcome = "skipped",
    promoted = 0,
    rechecked = 0,
    message = "",
  }: CompleteKnowledgeCatalogVerificationJobInput = {},
  finishedAt: string,
): Promise<void> {
  await db
    .prepare(`
      UPDATE knowledge_catalog_verification_jobs
      SET status = 'completed',
          outcome = ?,
          promoted = ?,
          rechecked = ?,
          finished_at = ?,
          available_at = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          last_message = ?,
          updated_at = ?
      WHERE id = ?
    `)
    .bind(
      outcome,
      promoted ? 1 : 0,
      rechecked ? 1 : 0,
      finishedAt,
      String(message || "").slice(0, 1000),
      finishedAt,
      jobId,
    )
    .run();
}

export async function deadLetterKnowledgeCatalogVerificationJob(
  db: QueryableDatabase,
  jobId: number,
  message: unknown,
  finishedAt: string,
): Promise<void> {
  await db
    .prepare(`
      UPDATE knowledge_catalog_verification_jobs
      SET status = 'dead_letter',
          outcome = 'error',
          finished_at = ?,
          available_at = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          last_message = ?,
          updated_at = ?
      WHERE id = ?
    `)
    .bind(finishedAt, String(message || "").slice(0, 1000), finishedAt, jobId)
    .run();
}

export async function acquireKnowledgeCatalogVerificationDomainLease(
  db: QueryableDatabase,
  hostname: string,
  jobId: number,
  leasedAt: string,
  leaseSeconds: number,
): Promise<boolean> {
  if (!hostname) return true;
  const leasedUntil = addSeconds(leasedAt, leaseSeconds);
  const result = await db
    .prepare(`
      INSERT INTO knowledge_catalog_verification_domain_leases (
        hostname, job_id, leased_until, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(hostname) DO UPDATE SET
        job_id = excluded.job_id,
        leased_until = excluded.leased_until,
        updated_at = excluded.updated_at
      WHERE knowledge_catalog_verification_domain_leases.leased_until <= ?
         OR knowledge_catalog_verification_domain_leases.job_id = ?
    `)
    .bind(hostname, jobId, leasedUntil, leasedAt, leasedAt, jobId)
    .run();
  return number(result?.meta?.changes) > 0;
}

export async function releaseKnowledgeCatalogVerificationDomainLease(
  db: QueryableDatabase,
  hostname: string,
  jobId: number,
  releasedAt?: string,
  pacingMilliseconds = 0,
): Promise<void> {
  if (!hostname) return;
  if (releasedAt && pacingMilliseconds > 0) {
    await db
      .prepare(`
        UPDATE knowledge_catalog_verification_domain_leases
        SET job_id = 0, leased_until = ?, updated_at = ?
        WHERE hostname = ? AND job_id = ?
      `)
      .bind(addMilliseconds(releasedAt, pacingMilliseconds), releasedAt, hostname, jobId)
      .run();
    return;
  }
  await db
    .prepare(`
      DELETE FROM knowledge_catalog_verification_domain_leases
      WHERE hostname = ? AND job_id = ?
    `)
    .bind(hostname, jobId)
    .run();
}

export async function setKnowledgeCatalogReviewRunQueueBaseline(
  db: QueryableDatabase,
  runId: number,
  baseline: ProductClassificationStats,
  message: unknown,
): Promise<void> {
  await db
    .prepare(`
      UPDATE knowledge_catalog_review_runs
      SET active_products_before = ?,
          unclassified_before = ?,
          other_before = ?,
          message = ?
      WHERE id = ?
    `)
    .bind(
      baseline.activeProducts || 0,
      baseline.unclassifiedProducts || 0,
      baseline.otherProducts || 0,
      String(message || "queued").slice(0, 1000),
      runId,
    )
    .run();
}

export async function knowledgeCatalogReviewRunQueueBaseline(
  db: QueryableDatabase,
  runId: number,
): Promise<ProductClassificationStats> {
  const row = await db
    .prepare(`
      SELECT active_products_before, unclassified_before, other_before
      FROM knowledge_catalog_review_runs
      WHERE id = ?
    `)
    .bind(runId)
    .first<
      Pick<
        import("./types.js").KnowledgeCatalogReviewRunRow,
        "active_products_before" | "unclassified_before" | "other_before"
      >
    >();
  return {
    activeProducts: number(row?.active_products_before),
    unclassifiedProducts: number(row?.unclassified_before),
    otherProducts: number(row?.other_before),
  };
}

export async function knowledgeCatalogVerificationRunStats(
  db: QueryableDatabase,
  runId: number,
): Promise<KnowledgeCatalogVerificationRunStats> {
  // Measured rather than `first()`: this is an aggregate, and an aggregate is exactly the statement
  // whose cost is invisible in the row it returns.
  const row = await firstMeasured<VerificationRunStatsRow>(
    db
      .prepare(`
      SELECT
        COUNT(*) AS target_jobs,
        SUM(CASE WHEN job_type = 'candidate' THEN 1 ELSE 0 END) AS candidate_jobs,
        SUM(CASE WHEN job_type = 'product_recheck' THEN 1 ELSE 0 END) AS product_recheck_jobs,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
        SUM(CASE WHEN status = 'retrying' THEN 1 ELSE 0 END) AS retrying,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter,
        SUM(source_attempts) AS source_attempts,
        SUM(promoted) AS promoted,
        SUM(rechecked) AS rechecked,
        SUM(CASE WHEN outcome = 'verified' THEN 1 ELSE 0 END) AS verified,
        SUM(CASE WHEN outcome = 'not_found' THEN 1 ELSE 0 END) AS not_found,
        SUM(CASE WHEN outcome = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous,
        SUM(CASE WHEN outcome = 'unsupported' THEN 1 ELSE 0 END) AS unsupported,
        SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS error,
        MIN(CASE WHEN status IN ('queued', 'processing', 'retrying') THEN enqueued_at END)
          AS oldest_pending_at
      FROM knowledge_catalog_verification_jobs
      WHERE run_id = ? AND job_type <> 'finalize'
    `)
      .bind(runId),
  );
  const queued = number(row?.queued);
  const processing = number(row?.processing);
  const retrying = number(row?.retrying);
  return {
    targetJobs: number(row?.target_jobs),
    candidateJobs: number(row?.candidate_jobs),
    productRecheckJobs: number(row?.product_recheck_jobs),
    queued,
    processing,
    retrying,
    completed: number(row?.completed),
    deadLetter: number(row?.dead_letter),
    outstanding: queued + processing + retrying,
    sourceAttempts: number(row?.source_attempts),
    promoted: number(row?.promoted),
    rechecked: number(row?.rechecked),
    oldestPendingAt: row?.oldest_pending_at || null,
    outcomes: {
      verified: number(row?.verified),
      notFound: number(row?.not_found),
      ambiguous: number(row?.ambiguous),
      unsupported: number(row?.unsupported),
      error: number(row?.error),
    },
  };
}

export interface KnowledgeCatalogReviewRunLiveness {
  /** Jobs the queue can still deliver: queued, processing, or awaiting a retry. */
  liveJobs: number;
  /** Every job the run created, the finalizer included. */
  totalJobs: number;
  /** The most recent write to any of the run's jobs, or `""` when the run created none. */
  lastActivityAt: string;
}

/**
 * Whether a review run still has work the queue can deliver.
 *
 * Unlike {@link knowledgeCatalogVerificationRunStats} this counts the finalizer too, because the
 * question it answers is whether anything at all can still advance the run. A run whose finalizer
 * is dead-lettered has no live jobs and can never reach `success` or `failed` on its own.
 */
export async function knowledgeCatalogReviewRunLiveness(
  db: QueryableDatabase,
  runId: number,
): Promise<KnowledgeCatalogReviewRunLiveness> {
  const row = await db
    .prepare(`
      SELECT
        SUM(CASE WHEN status IN ('queued', 'processing', 'retrying') THEN 1 ELSE 0 END) AS live_jobs,
        COUNT(*) AS total_jobs,
        MAX(updated_at) AS last_activity_at
      FROM knowledge_catalog_verification_jobs
      WHERE run_id = ?
    `)
    .bind(runId)
    .first<{
      live_jobs: number | null;
      total_jobs: number | null;
      last_activity_at: string | null;
    }>();
  return {
    liveJobs: number(row?.live_jobs),
    totalJobs: number(row?.total_jobs),
    lastActivityAt: row?.last_activity_at || "",
  };
}

/**
 * The run the most recently enqueued verification job belongs to.
 *
 * The scheduler asks one question of the verification queue -- has it ever been bootstrapped -- and
 * this is the whole answer. It used to arrive attached to a lifetime aggregate over every job ever
 * recorded, which the scheduler then discarded.
 *
 * `ORDER BY id DESC LIMIT 1` on the rowid alias walks the table backwards and stops at the first
 * row, so it costs one row however long the history is. `EXPLAIN QUERY PLAN` calls that a `SCAN`
 * with no temporary b-tree, which is the shape a `LIMIT` genuinely bounds -- unlike a `SCAN` that
 * has to sort before it can honour one.
 */
export async function latestKnowledgeCatalogVerificationRunId(
  db: QueryableDatabase,
): Promise<number | null> {
  const row = await firstMeasured<VerificationQueueBatchRow>(
    db.prepare(`
      SELECT run_id
      FROM knowledge_catalog_verification_jobs
      ORDER BY id DESC
      LIMIT 1
    `),
  );
  return number(row?.run_id) || null;
}

/**
 * Verification queue state, scoped to the current review run.
 *
 * Both halves used to be global: a lifetime aggregate over every job ever recorded, plus the latest
 * run's own stats. The counters are now the current run's, which is the question an operator is
 * actually asking and the only one any caller acted on. Reads scale with the run, not with history.
 */
export async function knowledgeCatalogVerificationQueueStatus(
  db: QueryableDatabase,
): Promise<KnowledgeCatalogVerificationQueueStatus> {
  const latestRunId = await latestKnowledgeCatalogVerificationRunId(db);
  const latestRun = latestRunId
    ? await knowledgeCatalogVerificationRunStats(db, latestRunId)
    : null;
  return {
    queued: latestRun?.queued ?? 0,
    processing: latestRun?.processing ?? 0,
    retrying: latestRun?.retrying ?? 0,
    deadLetter: latestRun?.deadLetter ?? 0,
    oldestPendingAt: latestRun?.oldestPendingAt ?? null,
    latestRun,
    latestRunId,
  };
}
