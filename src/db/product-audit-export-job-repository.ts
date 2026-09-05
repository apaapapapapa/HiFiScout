import { COMPLETE_ARCHIVE_PART_CHUNKS } from "../export/contracts.js";
import type { DataExportFormat } from "../export/contracts.js";
import type {
  ProductAuditExportJob,
  ProductAuditExportJobStatus,
  ProductAuditExportScope,
} from "../product-audit-export/types.js";
import type { QueryableDatabase } from "./types.js";

export const PRODUCT_AUDIT_EXPORT_READY_RETENTION_DAYS = 7;
export const PRODUCT_AUDIT_EXPORT_FAILED_RETENTION_DAYS = 1;
export const PRODUCT_AUDIT_EXPORT_GENERATION_DEADLINE_HOURS = 24;

interface ProductAuditExportJobRow {
  format: DataExportFormat;
  id: string;
  scope: ProductAuditExportScope;
  status: ProductAuditExportJobStatus;
  max_listing_id: number;
  after_id: number;
  chunk_count: number;
  row_count: number;
  byte_count: number;
  delivery_attempts: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  error: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  expires_at: string | null;
}

export interface ProductAuditExportJobCreation {
  job: ProductAuditExportJob;
  created: boolean;
}

export interface ClaimedProductAuditExportJob {
  job: ProductAuditExportJob;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface AdvanceProductAuditExportJobInput {
  jobId: string;
  leaseToken: string;
  expectedAfterId: number;
  expectedChunkCount: number;
  nextAfterId: number;
  addedRows: number;
  addedBytes: number;
  hasMore: boolean;
  advancedAt: Date;
}

export interface ProductAuditExportExpectedCursor {
  afterId: number;
  chunkCount: number;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addSeconds(date: Date, seconds: number): string {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

function addDays(date: Date, days: number): string {
  return addSeconds(date, days * 24 * 60 * 60);
}

function generationDeadline(date: Date): string {
  return addSeconds(date, PRODUCT_AUDIT_EXPORT_GENERATION_DEADLINE_HOURS * 60 * 60);
}

function jobFromRow(row: ProductAuditExportJobRow | null): ProductAuditExportJob | null {
  if (!row) return null;
  return {
    id: row.id,
    ...(row.format === "complete"
      ? {
          format: "complete" as const,
          archivePartCount: Math.ceil(number(row.chunk_count) / COMPLETE_ARCHIVE_PART_CHUNKS),
        }
      : {}),
    scope: row.scope,
    status: row.status,
    maxListingId: number(row.max_listing_id),
    afterId: number(row.after_id),
    chunkCount: number(row.chunk_count),
    rowCount: number(row.row_count),
    byteCount: number(row.byte_count),
    deliveryAttempts: number(row.delivery_attempts),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
    expiresAt: row.expires_at || null,
    error: row.error || "",
  };
}

async function activeProductAuditExportJob(
  db: QueryableDatabase,
  scope: ProductAuditExportScope,
): Promise<ProductAuditExportJob | null> {
  const row = await db
    .prepare(`
      SELECT *
      FROM product_audit_export_jobs
      WHERE scope = ? AND status IN ('queued', 'processing')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `)
    .bind(scope)
    .first<ProductAuditExportJobRow>();
  return jobFromRow(row);
}

async function maxProductAuditListingId(
  db: QueryableDatabase,
  scope: ProductAuditExportScope,
): Promise<number> {
  const sql =
    scope === "active"
      ? "SELECT COALESCE(MAX(id), 0) AS max_listing_id FROM products WHERE is_active = 1"
      : "SELECT COALESCE(MAX(id), 0) AS max_listing_id FROM products";
  const row = await db.prepare(sql).first<{ max_listing_id: number }>();
  return Math.max(0, number(row?.max_listing_id));
}

/** Releases the per-scope lock for a generation that exceeded its absolute deadline. */
async function failOverdueProductAuditExportJobs(
  db: QueryableDatabase,
  now: Date,
): Promise<number> {
  const timestamp = now.toISOString();
  const result = await db
    .prepare(`
      SELECT *
      FROM product_audit_export_jobs
      WHERE status IN ('queued', 'processing')
        AND expires_at IS NOT NULL
        AND expires_at <= ?
      ORDER BY expires_at ASC, id ASC
      LIMIT 2
    `)
    .bind(timestamp)
    .all<ProductAuditExportJobRow>();
  let failed = 0;
  for (const row of result.results || []) {
    if (
      await failProductAuditExportJob(
        db,
        row.id,
        "product_audit_export_generation_deadline_exceeded",
        now,
        { afterId: number(row.after_id), chunkCount: number(row.chunk_count) },
      )
    ) {
      failed += 1;
    }
  }
  return failed;
}

/**
 * Atomically opens one job per scope, or returns the queued/processing job another request won.
 */
export async function createOrReuseProductAuditExportJob(
  db: QueryableDatabase,
  scope: ProductAuditExportScope,
  jobId: string,
  createdAt: Date,
  format: DataExportFormat = "csv",
): Promise<ProductAuditExportJobCreation> {
  const timestamp = createdAt.toISOString();
  const existing = await activeProductAuditExportJob(db, scope);
  if (existing?.expiresAt && existing.expiresAt > timestamp) {
    return { job: existing, created: false };
  }
  if (existing) {
    await failProductAuditExportJob(
      db,
      existing.id,
      "product_audit_export_generation_deadline_exceeded",
      createdAt,
      { afterId: existing.afterId, chunkCount: existing.chunkCount },
    );
  }

  // A concurrent job can become terminal between INSERT OR IGNORE and SELECT. Retrying the same
  // UUID is safe because an ignored insert never consumed it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const maxListingId = await maxProductAuditListingId(db, scope);
    const result = await db
      .prepare(`
        INSERT OR IGNORE INTO product_audit_export_jobs (
          id, scope, status, max_listing_id, after_id, chunk_count, row_count, byte_count,
          delivery_attempts, error, created_at, updated_at, expires_at, format
        ) VALUES (?, ?, 'queued', ?, 0, 0, 0, 0, 0, '', ?, ?, ?, ?)
      `)
      .bind(jobId, scope, maxListingId, timestamp, timestamp, generationDeadline(createdAt), format)
      .run();
    const created = number(result?.meta?.changes) > 0;
    const job = created
      ? await getProductAuditExportJob(db, jobId)
      : await activeProductAuditExportJob(db, scope);
    if (job) return { job, created };
  }
  throw new Error("product_audit_export_job_create_race");
}

export async function getProductAuditExportJob(
  db: QueryableDatabase,
  jobId: string,
): Promise<ProductAuditExportJob | null> {
  const row = await db
    .prepare("SELECT * FROM product_audit_export_jobs WHERE id = ?")
    .bind(jobId)
    .first<ProductAuditExportJobRow>();
  return jobFromRow(row);
}

/** Reads the lease only when it still belongs to the exact cursor named by a delivery. */
export async function getProductAuditExportLeaseExpiry(
  db: QueryableDatabase,
  jobId: string,
  expectedCursor: ProductAuditExportExpectedCursor,
): Promise<string | null> {
  const row = await db
    .prepare(`
      SELECT lease_expires_at
      FROM product_audit_export_jobs
      WHERE id = ?
        AND status = 'processing'
        AND after_id = ?
        AND chunk_count = ?
    `)
    .bind(jobId, expectedCursor.afterId, expectedCursor.chunkCount)
    .first<{ lease_expires_at: string | null }>();
  return row?.lease_expires_at || null;
}

/** Returns the latest non-expired job so a page reload can resume polling or downloading it. */
export async function latestProductAuditExportJob(
  db: QueryableDatabase,
  scope: ProductAuditExportScope,
  now: Date = new Date(),
): Promise<ProductAuditExportJob | null> {
  let row = await db
    .prepare(`
      SELECT *
      FROM product_audit_export_jobs
      WHERE scope = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `)
    .bind(scope)
    .first<ProductAuditExportJobRow>();
  if (!row) return null;
  const timestamp = now.toISOString();
  if (
    (row.status === "queued" || row.status === "processing") &&
    row.expires_at &&
    row.expires_at <= timestamp
  ) {
    await failProductAuditExportJob(
      db,
      row.id,
      "product_audit_export_generation_deadline_exceeded",
      now,
      { afterId: number(row.after_id), chunkCount: number(row.chunk_count) },
    );
    row = await db
      .prepare(`
        SELECT *
        FROM product_audit_export_jobs
        WHERE scope = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      .bind(scope)
      .first<ProductAuditExportJobRow>();
  }
  if (row?.expires_at && row.expires_at <= timestamp) return null;
  return jobFromRow(row);
}

/** Backwards-readable alias for callers that use the conventional `getLatest...` prefix. */
export const getLatestProductAuditExportJob = latestProductAuditExportJob;

/** Reserves one stale cursor nudge without allowing repeated POST/poll calls to flood the Queue. */
export async function reserveProductAuditExportEnqueue(
  db: QueryableDatabase,
  jobId: string,
  expectedCursor: ProductAuditExportExpectedCursor,
  reservedAt: Date,
  staleSeconds: number,
): Promise<boolean> {
  const timestamp = reservedAt.toISOString();
  const staleBefore = addSeconds(reservedAt, -Math.max(30, staleSeconds));
  const result = await db
    .prepare(`
      UPDATE product_audit_export_jobs
      SET updated_at = ?
      WHERE id = ?
        AND after_id = ?
        AND chunk_count = ?
        AND status IN ('queued', 'processing')
        AND expires_at > ?
        AND updated_at <= ?
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

/** Finds at most the two scope-level jobs whose Queue delivery may have been lost. */
export async function staleProductAuditExportJobs(
  db: QueryableDatabase,
  now: Date,
  staleSeconds: number,
): Promise<ProductAuditExportJob[]> {
  await failOverdueProductAuditExportJobs(db, now);
  const timestamp = now.toISOString();
  const staleBefore = addSeconds(now, -Math.max(30, staleSeconds));
  const result = await db
    .prepare(`
      SELECT *
      FROM product_audit_export_jobs
      WHERE status IN ('queued', 'processing')
        AND expires_at > ?
        AND updated_at <= ?
        AND (status = 'queued' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
      ORDER BY updated_at ASC, id ASC
      LIMIT 2
    `)
    .bind(timestamp, staleBefore, timestamp)
    .all<ProductAuditExportJobRow>();
  return (result.results || []).map((row) => jobFromRow(row)).filter((job) => job !== null);
}

/** Claims exactly the cursor named by a Queue delivery, including recovery of an expired lease. */
export async function claimProductAuditExportJob(
  db: QueryableDatabase,
  jobId: string,
  expectedAfterId: number,
  expectedChunkCount: number,
  claimedAt: Date,
  leaseSeconds: number,
): Promise<ClaimedProductAuditExportJob | null> {
  const timestamp = claimedAt.toISOString();
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = addSeconds(claimedAt, Math.max(5, Math.min(3600, leaseSeconds)));
  const result = await db
    .prepare(`
      UPDATE product_audit_export_jobs
      SET status = 'processing',
          delivery_attempts = delivery_attempts + 1,
          lease_token = ?,
          lease_expires_at = ?,
          updated_at = ?
      WHERE id = ?
        AND after_id = ?
        AND chunk_count = ?
        AND expires_at > ?
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
  const job = await getProductAuditExportJob(db, jobId);
  return job ? { job, leaseToken, leaseExpiresAt } : null;
}

/** Releases a failed delivery without changing its cursor, ready for the Queue retry. */
export async function releaseProductAuditExportJobClaim(
  db: QueryableDatabase,
  jobId: string,
  leaseToken: string,
  releasedAt: Date,
  error: unknown,
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE product_audit_export_jobs
      SET status = 'queued', lease_token = NULL, lease_expires_at = NULL,
          error = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
    `)
    .bind(String(error || "").slice(0, 1000), releasedAt.toISOString(), jobId, leaseToken)
    .run();
  return number(result?.meta?.changes) > 0;
}

/**
 * Advances a claimed cursor with compare-and-swap semantics.
 *
 * The caller must enqueue any continuation before invoking this function. That ordering ensures a
 * crash cannot commit a cursor for which no Queue message exists.
 */
export async function advanceProductAuditExportJob(
  db: QueryableDatabase,
  input: AdvanceProductAuditExportJobInput,
): Promise<boolean> {
  const timestamp = input.advancedAt.toISOString();
  const status: ProductAuditExportJobStatus = input.hasMore ? "queued" : "ready";
  const completedAt = input.hasMore ? null : timestamp;
  const readyExpiresAt = input.hasMore
    ? null
    : addDays(input.advancedAt, PRODUCT_AUDIT_EXPORT_READY_RETENTION_DAYS);
  const result = await db
    .prepare(`
      UPDATE product_audit_export_jobs
      SET status = ?,
          after_id = ?,
          chunk_count = chunk_count + 1,
          row_count = row_count + ?,
          byte_count = byte_count + ?,
          lease_token = NULL,
          lease_expires_at = NULL,
          error = '',
          updated_at = ?,
          completed_at = ?,
          expires_at = COALESCE(?, expires_at)
      WHERE id = ?
        AND status = 'processing'
        AND lease_token = ?
        AND after_id = ?
        AND chunk_count = ?
        AND expires_at > ?
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

/** Closes an in-flight job and retains its diagnostics for one day. */
export async function failProductAuditExportJob(
  db: QueryableDatabase,
  jobId: string,
  error: unknown,
  failedAt: Date = new Date(),
  expectedCursor?: ProductAuditExportExpectedCursor,
): Promise<boolean> {
  const timestamp = failedAt.toISOString();
  const cursorClause = expectedCursor ? "AND after_id = ? AND chunk_count = ?" : "";
  const bindings: unknown[] = [
    String(error || "product_audit_export_failed").slice(0, 1000),
    timestamp,
    timestamp,
    addDays(failedAt, PRODUCT_AUDIT_EXPORT_FAILED_RETENTION_DAYS),
    jobId,
  ];
  if (expectedCursor) bindings.push(expectedCursor.afterId, expectedCursor.chunkCount);
  const result = await db
    .prepare(`
      UPDATE product_audit_export_jobs
      SET status = 'failed',
          lease_token = NULL,
          lease_expires_at = NULL,
          error = ?,
          updated_at = ?,
          completed_at = ?,
          expires_at = ?
      WHERE id = ? AND status IN ('queued', 'processing')
        ${cursorClause}
    `)
    .bind(...bindings)
    .run();
  return number(result?.meta?.changes) > 0;
}

/** DLQ terminal CAS: it must never fail a cursor that a main-queue worker just claimed. */
export async function failQueuedProductAuditExportJob(
  db: QueryableDatabase,
  jobId: string,
  error: unknown,
  failedAt: Date,
  expectedCursor: ProductAuditExportExpectedCursor,
): Promise<boolean> {
  const timestamp = failedAt.toISOString();
  const result = await db
    .prepare(`
      UPDATE product_audit_export_jobs
      SET status = 'failed',
          lease_token = NULL,
          lease_expires_at = NULL,
          error = ?,
          updated_at = ?,
          completed_at = ?,
          expires_at = ?
      WHERE id = ?
        AND status = 'queued'
        AND after_id = ?
        AND chunk_count = ?
    `)
    .bind(
      String(error || "product_audit_export_failed").slice(0, 1000),
      timestamp,
      timestamp,
      addDays(failedAt, PRODUCT_AUDIT_EXPORT_FAILED_RETENTION_DAYS),
      jobId,
      expectedCursor.afterId,
      expectedCursor.chunkCount,
    )
    .run();
  return number(result?.meta?.changes) > 0;
}

/** Fails only the exact lease held by the caller, never a later claimant of the same cursor. */
export async function failClaimedProductAuditExportJob(
  db: QueryableDatabase,
  jobId: string,
  leaseToken: string,
  error: unknown,
  failedAt: Date,
  expectedCursor: ProductAuditExportExpectedCursor,
): Promise<boolean> {
  const timestamp = failedAt.toISOString();
  const result = await db
    .prepare(`
      UPDATE product_audit_export_jobs
      SET status = 'failed',
          lease_token = NULL,
          lease_expires_at = NULL,
          error = ?,
          updated_at = ?,
          completed_at = ?,
          expires_at = ?
      WHERE id = ?
        AND status = 'processing'
        AND lease_token = ?
        AND after_id = ?
        AND chunk_count = ?
    `)
    .bind(
      String(error || "product_audit_export_failed").slice(0, 1000),
      timestamp,
      timestamp,
      addDays(failedAt, PRODUCT_AUDIT_EXPORT_FAILED_RETENTION_DAYS),
      jobId,
      leaseToken,
      expectedCursor.afterId,
      expectedCursor.chunkCount,
    )
    .run();
  return number(result?.meta?.changes) > 0;
}
