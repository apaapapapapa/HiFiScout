import type {
  AdvanceDataExportJobInput,
  ClaimedDataExportJob,
  DataExportCursor,
  DataExportJob,
  DataExportJobStatus,
  DataExportKind,
} from "../export/contracts.js";
import type { QueryableDatabase } from "./types.js";

const JOB_TABLES = {
  knowledge_catalog_export: "knowledge_catalog_export_jobs",
  product_audit_export: "product_audit_export_jobs",
} as const satisfies Record<DataExportKind, string>;

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addSeconds(date: Date, seconds: number): string {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

interface ExportJobLifecycleOptions<Job extends DataExportJob> {
  getJob: (db: QueryableDatabase, jobId: string) => Promise<Job | null>;
  readyRetentionDays: number;
  failedRetentionDays: number;
}

/**
 * Both exports share cursor/lease fencing. Creation, scope selection and row mapping remain in
 * their repositories. SQL identifiers come only from this fixed map; all job values are bound.
 */
export function createDataExportJobLifecycle<Job extends DataExportJob>(
  kind: DataExportKind,
  options: ExportJobLifecycleOptions<Job>,
) {
  const table = JOB_TABLES[kind];
  const failedMessage = `${kind}_failed`;
  const failedExpiry = (date: Date) => addSeconds(date, options.failedRetentionDays * 24 * 60 * 60);

  /** Reads only the lease for the exact cursor named by a delivery. */
  async function getLeaseExpiry(
    db: QueryableDatabase,
    jobId: string,
    expectedCursor: DataExportCursor,
  ): Promise<string | null> {
    const row = await db
      .prepare(`
        SELECT lease_expires_at
        FROM ${table}
        WHERE id = ? AND status = 'processing' AND after_id = ? AND chunk_count = ?
      `)
      .bind(jobId, expectedCursor.afterId, expectedCursor.chunkCount)
      .first<{ lease_expires_at: string | null }>();
    return row?.lease_expires_at || null;
  }

  /** Reserves one stale cursor nudge without flooding the Queue on repeated POST/poll calls. */
  async function reserveEnqueue(
    db: QueryableDatabase,
    jobId: string,
    expectedCursor: DataExportCursor,
    reservedAt: Date,
    staleSeconds: number,
  ): Promise<boolean> {
    const timestamp = reservedAt.toISOString();
    const staleBefore = addSeconds(reservedAt, -Math.max(30, staleSeconds));
    const result = await db
      .prepare(`
        UPDATE ${table}
        SET updated_at = ?
        WHERE id = ? AND after_id = ? AND chunk_count = ?
          AND status IN ('queued', 'processing')
          AND expires_at > ? AND updated_at <= ?
          AND (status = 'queued' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
      `)
      .bind(
        timestamp,
        jobId,
        expectedCursor.afterId,
        expectedCursor.chunkCount,
        timestamp,
        staleBefore,
        timestamp,
      )
      .run();
    return number(result?.meta?.changes) > 0;
  }

  /** Claims exactly the delivered cursor, including recovery of an expired lease. */
  async function claim(
    db: QueryableDatabase,
    jobId: string,
    expectedAfterId: number,
    expectedChunkCount: number,
    claimedAt: Date,
    leaseSeconds: number,
  ): Promise<ClaimedDataExportJob<Job> | null> {
    const timestamp = claimedAt.toISOString();
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = addSeconds(claimedAt, Math.max(5, Math.min(3600, leaseSeconds)));
    const result = await db
      .prepare(`
        UPDATE ${table}
        SET status = 'processing', delivery_attempts = delivery_attempts + 1,
            lease_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND after_id = ? AND chunk_count = ? AND expires_at > ?
          AND (
            status = 'queued'
            OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
          )
      `)
      .bind(
        leaseToken,
        leaseExpiresAt,
        timestamp,
        jobId,
        expectedAfterId,
        expectedChunkCount,
        timestamp,
        timestamp,
      )
      .run();
    if (number(result?.meta?.changes) === 0) return null;
    const job = await options.getJob(db, jobId);
    return job ? { job, leaseToken, leaseExpiresAt } : null;
  }

  /** Releases a failed delivery without changing its cursor, ready for the Queue retry. */
  async function releaseClaim(
    db: QueryableDatabase,
    jobId: string,
    leaseToken: string,
    releasedAt: Date,
    error: unknown,
  ): Promise<boolean> {
    const result = await db
      .prepare(`
        UPDATE ${table}
        SET status = 'queued', lease_token = NULL, lease_expires_at = NULL,
            error = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_token = ?
      `)
      .bind(String(error || "").slice(0, 1000), releasedAt.toISOString(), jobId, leaseToken)
      .run();
    return number(result?.meta?.changes) > 0;
  }

  /** Caller must enqueue any continuation before this exact-cursor/lease CAS. */
  async function advance(
    db: QueryableDatabase,
    input: AdvanceDataExportJobInput,
  ): Promise<boolean> {
    const timestamp = input.advancedAt.toISOString();
    const status: DataExportJobStatus = input.hasMore ? "queued" : "ready";
    const completedAt = input.hasMore ? null : timestamp;
    const readyExpiresAt = input.hasMore
      ? null
      : addSeconds(input.advancedAt, options.readyRetentionDays * 24 * 60 * 60);
    const result = await db
      .prepare(`
        UPDATE ${table}
        SET status = ?, after_id = ?, chunk_count = chunk_count + 1,
            row_count = row_count + ?, byte_count = byte_count + ?,
            lease_token = NULL, lease_expires_at = NULL, error = '', updated_at = ?,
            completed_at = ?, expires_at = COALESCE(?, expires_at)
        WHERE id = ? AND status = 'processing' AND lease_token = ?
          AND after_id = ? AND chunk_count = ? AND expires_at > ?
      `)
      .bind(
        status,
        Math.max(0, input.nextAfterId),
        Math.max(0, input.addedRows),
        Math.max(0, input.addedBytes),
        timestamp,
        completedAt,
        readyExpiresAt,
        input.jobId,
        input.leaseToken,
        input.expectedAfterId,
        input.expectedChunkCount,
        timestamp,
      )
      .run();
    return number(result?.meta?.changes) > 0;
  }

  /** Closes an in-flight job; callers can require an exact cursor. */
  async function fail(
    db: QueryableDatabase,
    jobId: string,
    error: unknown,
    failedAt: Date = new Date(),
    expectedCursor?: DataExportCursor,
  ): Promise<boolean> {
    const timestamp = failedAt.toISOString();
    const cursorClause = expectedCursor ? "AND after_id = ? AND chunk_count = ?" : "";
    const bindings: unknown[] = [
      String(error || failedMessage).slice(0, 1000),
      timestamp,
      timestamp,
      failedExpiry(failedAt),
      jobId,
    ];
    if (expectedCursor) bindings.push(expectedCursor.afterId, expectedCursor.chunkCount);
    const result = await db
      .prepare(`
        UPDATE ${table}
        SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
            error = ?, updated_at = ?, completed_at = ?, expires_at = ?
        WHERE id = ? AND status IN ('queued', 'processing') ${cursorClause}
      `)
      .bind(...bindings)
      .run();
    return number(result?.meta?.changes) > 0;
  }

  /** DLQ terminal CAS: never fail a cursor that a main-queue worker just claimed. */
  async function failQueued(
    db: QueryableDatabase,
    jobId: string,
    error: unknown,
    failedAt: Date,
    expectedCursor: DataExportCursor,
  ): Promise<boolean> {
    const timestamp = failedAt.toISOString();
    const result = await db
      .prepare(`
        UPDATE ${table}
        SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
            error = ?, updated_at = ?, completed_at = ?, expires_at = ?
        WHERE id = ? AND status = 'queued' AND after_id = ? AND chunk_count = ?
      `)
      .bind(
        String(error || failedMessage).slice(0, 1000),
        timestamp,
        timestamp,
        failedExpiry(failedAt),
        jobId,
        expectedCursor.afterId,
        expectedCursor.chunkCount,
      )
      .run();
    return number(result?.meta?.changes) > 0;
  }

  /** Fails only the exact lease held by the caller, never a later claimant of the same cursor. */
  async function failClaimed(
    db: QueryableDatabase,
    jobId: string,
    leaseToken: string,
    error: unknown,
    failedAt: Date,
    expectedCursor: DataExportCursor,
  ): Promise<boolean> {
    const timestamp = failedAt.toISOString();
    const result = await db
      .prepare(`
        UPDATE ${table}
        SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
            error = ?, updated_at = ?, completed_at = ?, expires_at = ?
        WHERE id = ? AND status = 'processing' AND lease_token = ?
          AND after_id = ? AND chunk_count = ?
      `)
      .bind(
        String(error || failedMessage).slice(0, 1000),
        timestamp,
        timestamp,
        failedExpiry(failedAt),
        jobId,
        leaseToken,
        expectedCursor.afterId,
        expectedCursor.chunkCount,
      )
      .run();
    return number(result?.meta?.changes) > 0;
  }

  return {
    getLeaseExpiry,
    reserveEnqueue,
    claim,
    releaseClaim,
    advance,
    fail,
    failQueued,
    failClaimed,
  };
}
