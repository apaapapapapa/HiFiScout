import type {
  AdvanceDataExportJobInput,
  ClaimedDataExportJob,
  DataExportCursor,
} from "../export/contracts.js";
import { COMPLETE_ARCHIVE_PART_CHUNKS } from "../export/contracts.js";
import type { DataExportFormat } from "../export/contracts.js";
import type {
  ProductAuditExportJob,
  ProductAuditExportJobStatus,
  ProductAuditExportScope,
} from "../product-audit-export/types.js";
import type { QueryableDatabase } from "./types.js";
import { createDataExportJobLifecycle } from "./data-export-job-lifecycle.js";

export const PRODUCT_AUDIT_EXPORT_READY_RETENTION_DAYS = 7;
export const PRODUCT_AUDIT_EXPORT_FAILED_RETENTION_DAYS = 1;
export const PRODUCT_AUDIT_EXPORT_GENERATION_DEADLINE_HOURS = 24;

export const {
  getLeaseExpiry: getProductAuditExportLeaseExpiry,
  reserveEnqueue: reserveProductAuditExportEnqueue,
  claim: claimProductAuditExportJob,
  releaseClaim: releaseProductAuditExportJobClaim,
  advance: advanceProductAuditExportJob,
  fail: failProductAuditExportJob,
  failQueued: failQueuedProductAuditExportJob,
  failClaimed: failClaimedProductAuditExportJob,
} = createDataExportJobLifecycle("product_audit_export", {
  getJob: getProductAuditExportJob,
  readyRetentionDays: PRODUCT_AUDIT_EXPORT_READY_RETENTION_DAYS,
  failedRetentionDays: PRODUCT_AUDIT_EXPORT_FAILED_RETENTION_DAYS,
});

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

export type ClaimedProductAuditExportJob = ClaimedDataExportJob<ProductAuditExportJob>;

export type AdvanceProductAuditExportJobInput = AdvanceDataExportJobInput;

export type ProductAuditExportExpectedCursor = DataExportCursor;

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addSeconds(date: Date, seconds: number): string {
  return new Date(date.getTime() + seconds * 1000).toISOString();
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
