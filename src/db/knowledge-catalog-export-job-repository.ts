import { COMPLETE_ARCHIVE_PART_CHUNKS } from "../export/contracts.js";
import type { DataExportFormat } from "../export/contracts.js";
import type {
  KnowledgeCatalogExportJob,
  KnowledgeCatalogExportJobStatus,
} from "../knowledge-catalog-export/types.js";
import type { QueryableDatabase } from "./types.js";

export const KNOWLEDGE_CATALOG_EXPORT_READY_RETENTION_DAYS = 7;
export const KNOWLEDGE_CATALOG_EXPORT_FAILED_RETENTION_DAYS = 1;
export const KNOWLEDGE_CATALOG_EXPORT_GENERATION_DEADLINE_HOURS = 24;

interface KnowledgeCatalogExportJobRow {
  format: DataExportFormat;
  id: string;
  status: KnowledgeCatalogExportJobStatus;
  max_catalog_product_id: number;
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
  expires_at: string;
}

export interface KnowledgeCatalogExportJobCreation {
  job: KnowledgeCatalogExportJob;
  created: boolean;
}

export interface ClaimedKnowledgeCatalogExportJob {
  job: KnowledgeCatalogExportJob;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface AdvanceKnowledgeCatalogExportJobInput {
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

export interface KnowledgeCatalogExportExpectedCursor {
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
  return addSeconds(date, KNOWLEDGE_CATALOG_EXPORT_GENERATION_DEADLINE_HOURS * 60 * 60);
}

function jobFromRow(row: KnowledgeCatalogExportJobRow | null): KnowledgeCatalogExportJob | null {
  if (!row) return null;
  return {
    id: row.id,
    ...(row.format === "complete"
      ? {
          format: "complete" as const,
          archivePartCount: Math.ceil(number(row.chunk_count) / COMPLETE_ARCHIVE_PART_CHUNKS),
        }
      : {}),
    status: row.status,
    maxCatalogProductId: number(row.max_catalog_product_id),
    afterId: number(row.after_id),
    chunkCount: number(row.chunk_count),
    rowCount: number(row.row_count),
    byteCount: number(row.byte_count),
    deliveryAttempts: number(row.delivery_attempts),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
    expiresAt: row.expires_at,
    error: row.error || "",
  };
}

async function activeKnowledgeCatalogExportJob(
  db: QueryableDatabase,
): Promise<KnowledgeCatalogExportJob | null> {
  const row = await db
    .prepare(`
      SELECT *
      FROM knowledge_catalog_export_jobs
      WHERE status IN ('queued', 'processing')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `)
    .first<KnowledgeCatalogExportJobRow>();
  return jobFromRow(row);
}

async function maxKnowledgeCatalogProductId(db: QueryableDatabase): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(id), 0) AS max_catalog_product_id FROM knowledge_catalog_products",
    )
    .first<{ max_catalog_product_id: number }>();
  return Math.max(0, number(row?.max_catalog_product_id));
}

async function failOverdueKnowledgeCatalogExportJobs(
  db: QueryableDatabase,
  now: Date,
): Promise<number> {
  const timestamp = now.toISOString();
  const result = await db
    .prepare(`
      SELECT *
      FROM knowledge_catalog_export_jobs
      WHERE status IN ('queued', 'processing') AND expires_at <= ?
      ORDER BY expires_at ASC, id ASC
      LIMIT 1
    `)
    .bind(timestamp)
    .all<KnowledgeCatalogExportJobRow>();
  let failed = 0;
  for (const row of result.results || []) {
    if (
      await failKnowledgeCatalogExportJob(
        db,
        row.id,
        "knowledge_catalog_export_generation_deadline_exceeded",
        now,
        { afterId: number(row.after_id), chunkCount: number(row.chunk_count) },
      )
    ) {
      failed += 1;
    }
  }
  return failed;
}

/** Atomically opens the singleton job, or returns the active job another request won. */
export async function createOrReuseKnowledgeCatalogExportJob(
  db: QueryableDatabase,
  jobId: string,
  createdAt: Date,
  format: DataExportFormat = "csv",
): Promise<KnowledgeCatalogExportJobCreation> {
  const timestamp = createdAt.toISOString();
  const existing = await activeKnowledgeCatalogExportJob(db);
  if (existing && existing.expiresAt > timestamp) return { job: existing, created: false };
  if (existing) {
    await failKnowledgeCatalogExportJob(
      db,
      existing.id,
      "knowledge_catalog_export_generation_deadline_exceeded",
      createdAt,
      { afterId: existing.afterId, chunkCount: existing.chunkCount },
    );
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const maxCatalogProductId = await maxKnowledgeCatalogProductId(db);
    const result = await db
      .prepare(`
        INSERT OR IGNORE INTO knowledge_catalog_export_jobs (
          id, singleton_key, status, max_catalog_product_id, after_id, chunk_count, row_count,
          byte_count, delivery_attempts, error, created_at, updated_at, expires_at, format
        ) VALUES (?, 1, 'queued', ?, 0, 0, 0, 0, 0, '', ?, ?, ?, ?)
      `)
      .bind(jobId, maxCatalogProductId, timestamp, timestamp, generationDeadline(createdAt), format)
      .run();
    const created = number(result?.meta?.changes) > 0;
    const job = created
      ? await getKnowledgeCatalogExportJob(db, jobId)
      : await activeKnowledgeCatalogExportJob(db);
    if (job) return { job, created };
  }
  throw new Error("knowledge_catalog_export_job_create_race");
}

export async function getKnowledgeCatalogExportJob(
  db: QueryableDatabase,
  jobId: string,
): Promise<KnowledgeCatalogExportJob | null> {
  const row = await db
    .prepare("SELECT * FROM knowledge_catalog_export_jobs WHERE id = ?")
    .bind(jobId)
    .first<KnowledgeCatalogExportJobRow>();
  return jobFromRow(row);
}

export async function getKnowledgeCatalogExportLeaseExpiry(
  db: QueryableDatabase,
  jobId: string,
  expectedCursor: KnowledgeCatalogExportExpectedCursor,
): Promise<string | null> {
  const row = await db
    .prepare(`
      SELECT lease_expires_at
      FROM knowledge_catalog_export_jobs
      WHERE id = ? AND status = 'processing' AND after_id = ? AND chunk_count = ?
    `)
    .bind(jobId, expectedCursor.afterId, expectedCursor.chunkCount)
    .first<{ lease_expires_at: string | null }>();
  return row?.lease_expires_at || null;
}

/** Returns the latest non-expired job for page reload/status polling. */
export async function getLatestKnowledgeCatalogExportJob(
  db: QueryableDatabase,
  now: Date = new Date(),
): Promise<KnowledgeCatalogExportJob | null> {
  let row = await db
    .prepare(`
      SELECT * FROM knowledge_catalog_export_jobs
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `)
    .first<KnowledgeCatalogExportJobRow>();
  if (!row) return null;
  const timestamp = now.toISOString();
  if ((row.status === "queued" || row.status === "processing") && row.expires_at <= timestamp) {
    await failKnowledgeCatalogExportJob(
      db,
      row.id,
      "knowledge_catalog_export_generation_deadline_exceeded",
      now,
      { afterId: number(row.after_id), chunkCount: number(row.chunk_count) },
    );
    row = await db
      .prepare(`
        SELECT * FROM knowledge_catalog_export_jobs
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      .first<KnowledgeCatalogExportJobRow>();
  }
  if (row && row.expires_at <= timestamp) return null;
  return jobFromRow(row);
}

export async function reserveKnowledgeCatalogExportEnqueue(
  db: QueryableDatabase,
  jobId: string,
  expectedCursor: KnowledgeCatalogExportExpectedCursor,
  reservedAt: Date,
  staleSeconds: number,
): Promise<boolean> {
  const timestamp = reservedAt.toISOString();
  const staleBefore = addSeconds(reservedAt, -Math.max(30, staleSeconds));
  const result = await db
    .prepare(`
      UPDATE knowledge_catalog_export_jobs
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

export async function staleKnowledgeCatalogExportJobs(
  db: QueryableDatabase,
  now: Date,
  staleSeconds: number,
): Promise<KnowledgeCatalogExportJob[]> {
  await failOverdueKnowledgeCatalogExportJobs(db, now);
  const timestamp = now.toISOString();
  const staleBefore = addSeconds(now, -Math.max(30, staleSeconds));
  const result = await db
    .prepare(`
      SELECT * FROM knowledge_catalog_export_jobs
      WHERE status IN ('queued', 'processing')
        AND expires_at > ? AND updated_at <= ?
        AND (status = 'queued' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
      ORDER BY updated_at ASC, id ASC
      LIMIT 1
    `)
    .bind(timestamp, staleBefore, timestamp)
    .all<KnowledgeCatalogExportJobRow>();
  return (result.results || []).map((row) => jobFromRow(row)).filter((job) => job !== null);
}

export async function claimKnowledgeCatalogExportJob(
  db: QueryableDatabase,
  jobId: string,
  expectedAfterId: number,
  expectedChunkCount: number,
  claimedAt: Date,
  leaseSeconds: number,
): Promise<ClaimedKnowledgeCatalogExportJob | null> {
  const timestamp = claimedAt.toISOString();
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = addSeconds(claimedAt, Math.max(5, Math.min(3600, leaseSeconds)));
  const result = await db
    .prepare(`
      UPDATE knowledge_catalog_export_jobs
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
  const job = await getKnowledgeCatalogExportJob(db, jobId);
  return job ? { job, leaseToken, leaseExpiresAt } : null;
}

export async function releaseKnowledgeCatalogExportJobClaim(
  db: QueryableDatabase,
  jobId: string,
  leaseToken: string,
  releasedAt: Date,
  error: unknown,
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE knowledge_catalog_export_jobs
      SET status = 'queued', lease_token = NULL, lease_expires_at = NULL,
          error = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
    `)
    .bind(String(error || "").slice(0, 1000), releasedAt.toISOString(), jobId, leaseToken)
    .run();
  return number(result?.meta?.changes) > 0;
}

/** Caller must enqueue the continuation before this exact-cursor CAS. */
export async function advanceKnowledgeCatalogExportJob(
  db: QueryableDatabase,
  input: AdvanceKnowledgeCatalogExportJobInput,
): Promise<boolean> {
  const timestamp = input.advancedAt.toISOString();
  const status: KnowledgeCatalogExportJobStatus = input.hasMore ? "queued" : "ready";
  const completedAt = input.hasMore ? null : timestamp;
  const readyExpiresAt = input.hasMore
    ? null
    : addDays(input.advancedAt, KNOWLEDGE_CATALOG_EXPORT_READY_RETENTION_DAYS);
  const result = await db
    .prepare(`
      UPDATE knowledge_catalog_export_jobs
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

export async function failKnowledgeCatalogExportJob(
  db: QueryableDatabase,
  jobId: string,
  error: unknown,
  failedAt: Date = new Date(),
  expectedCursor?: KnowledgeCatalogExportExpectedCursor,
): Promise<boolean> {
  const timestamp = failedAt.toISOString();
  const cursorClause = expectedCursor ? "AND after_id = ? AND chunk_count = ?" : "";
  const bindings: unknown[] = [
    String(error || "knowledge_catalog_export_failed").slice(0, 1000),
    timestamp,
    timestamp,
    addDays(failedAt, KNOWLEDGE_CATALOG_EXPORT_FAILED_RETENTION_DAYS),
    jobId,
  ];
  if (expectedCursor) bindings.push(expectedCursor.afterId, expectedCursor.chunkCount);
  const result = await db
    .prepare(`
      UPDATE knowledge_catalog_export_jobs
      SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
          error = ?, updated_at = ?, completed_at = ?, expires_at = ?
      WHERE id = ? AND status IN ('queued', 'processing') ${cursorClause}
    `)
    .bind(...bindings)
    .run();
  return number(result?.meta?.changes) > 0;
}

/** DLQ terminal CAS: it must never fail a cursor claimed by a main-queue worker. */
export async function failQueuedKnowledgeCatalogExportJob(
  db: QueryableDatabase,
  jobId: string,
  error: unknown,
  failedAt: Date,
  expectedCursor: KnowledgeCatalogExportExpectedCursor,
): Promise<boolean> {
  const timestamp = failedAt.toISOString();
  const result = await db
    .prepare(`
      UPDATE knowledge_catalog_export_jobs
      SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
          error = ?, updated_at = ?, completed_at = ?, expires_at = ?
      WHERE id = ? AND status = 'queued' AND after_id = ? AND chunk_count = ?
    `)
    .bind(
      String(error || "knowledge_catalog_export_failed").slice(0, 1000),
      timestamp,
      timestamp,
      addDays(failedAt, KNOWLEDGE_CATALOG_EXPORT_FAILED_RETENTION_DAYS),
      jobId,
      expectedCursor.afterId,
      expectedCursor.chunkCount,
    )
    .run();
  return number(result?.meta?.changes) > 0;
}

/** Fails only the exact lease held by the caller, never a later claimant. */
export async function failClaimedKnowledgeCatalogExportJob(
  db: QueryableDatabase,
  jobId: string,
  leaseToken: string,
  error: unknown,
  failedAt: Date,
  expectedCursor: KnowledgeCatalogExportExpectedCursor,
): Promise<boolean> {
  const timestamp = failedAt.toISOString();
  const result = await db
    .prepare(`
      UPDATE knowledge_catalog_export_jobs
      SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
          error = ?, updated_at = ?, completed_at = ?, expires_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND after_id = ? AND chunk_count = ?
    `)
    .bind(
      String(error || "knowledge_catalog_export_failed").slice(0, 1000),
      timestamp,
      timestamp,
      addDays(failedAt, KNOWLEDGE_CATALOG_EXPORT_FAILED_RETENTION_DAYS),
      jobId,
      leaseToken,
      expectedCursor.afterId,
      expectedCursor.chunkCount,
    )
    .run();
  return number(result?.meta?.changes) > 0;
}
