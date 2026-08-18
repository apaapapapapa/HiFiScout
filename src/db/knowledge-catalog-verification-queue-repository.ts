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
}

interface VerificationQueueBatchRow {
  queued?: number | null;
  processing?: number | null;
  retrying?: number | null;
  dead_letter?: number | null;
  oldest_pending_at?: string | null;
  run_id?: number;
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + Math.max(1, Number(seconds) || 1) * 1000).toISOString();
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
          enqueued_at, available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
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
  const row = await db
    .prepare("SELECT * FROM knowledge_catalog_verification_jobs WHERE id = ?")
    .bind(jobId)
    .first<KnowledgeCatalogVerificationJobRow>();
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
): Promise<void> {
  if (!hostname) return;
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
  const row = await db
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
        SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS error
      FROM knowledge_catalog_verification_jobs
      WHERE run_id = ? AND job_type <> 'finalize'
    `)
    .bind(runId)
    .first<VerificationRunStatsRow>();
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
    outcomes: {
      verified: number(row?.verified),
      notFound: number(row?.not_found),
      ambiguous: number(row?.ambiguous),
      unsupported: number(row?.unsupported),
      error: number(row?.error),
    },
  };
}

export async function knowledgeCatalogVerificationQueueStatus(
  db: QueryableDatabase,
): Promise<KnowledgeCatalogVerificationQueueStatus> {
  const results = await db.batch<VerificationQueueBatchRow>([
    db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
        SUM(CASE WHEN status = 'retrying' THEN 1 ELSE 0 END) AS retrying,
        SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter,
        MIN(CASE WHEN status IN ('queued', 'processing', 'retrying') THEN enqueued_at END) AS oldest_pending_at
      FROM knowledge_catalog_verification_jobs
      WHERE job_type <> 'finalize'
    `),
    db.prepare(`
      SELECT run_id
      FROM knowledge_catalog_verification_jobs
      ORDER BY id DESC
      LIMIT 1
    `),
  ]);
  const current = results?.[0]?.results?.[0] || {};
  const latestRunId = number(results?.[1]?.results?.[0]?.run_id);
  return {
    queued: number(current.queued),
    processing: number(current.processing),
    retrying: number(current.retrying),
    deadLetter: number(current.dead_letter),
    oldestPendingAt: current.oldest_pending_at || null,
    latestRun: latestRunId ? await knowledgeCatalogVerificationRunStats(db, latestRunId) : null,
    latestRunId: latestRunId || null,
  };
}
