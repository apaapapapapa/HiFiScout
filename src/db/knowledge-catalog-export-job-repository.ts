import type {
  AdvanceDataExportJobInput,
  ClaimedDataExportJob,
  DataExportCursor,
} from "../export/contracts.js";
import { COMPLETE_ARCHIVE_PART_CHUNKS } from "../export/contracts.js";
import type { DataExportFormat } from "../export/contracts.js";
import type {
  KnowledgeCatalogExportJob,
  KnowledgeCatalogExportJobStatus,
} from "../knowledge-catalog-export/types.js";
import type { QueryableDatabase } from "./types.js";
import { createDataExportJobLifecycle } from "./data-export-job-lifecycle.js";

export const KNOWLEDGE_CATALOG_EXPORT_READY_RETENTION_DAYS = 7;
export const KNOWLEDGE_CATALOG_EXPORT_FAILED_RETENTION_DAYS = 1;
export const KNOWLEDGE_CATALOG_EXPORT_GENERATION_DEADLINE_HOURS = 24;

export const {
  getLeaseExpiry: getKnowledgeCatalogExportLeaseExpiry,
  reserveEnqueue: reserveKnowledgeCatalogExportEnqueue,
  claim: claimKnowledgeCatalogExportJob,
  releaseClaim: releaseKnowledgeCatalogExportJobClaim,
  advance: advanceKnowledgeCatalogExportJob,
  fail: failKnowledgeCatalogExportJob,
  failQueued: failQueuedKnowledgeCatalogExportJob,
  failClaimed: failClaimedKnowledgeCatalogExportJob,
} = createDataExportJobLifecycle("knowledge_catalog_export", {
  getJob: getKnowledgeCatalogExportJob,
  readyRetentionDays: KNOWLEDGE_CATALOG_EXPORT_READY_RETENTION_DAYS,
  failedRetentionDays: KNOWLEDGE_CATALOG_EXPORT_FAILED_RETENTION_DAYS,
});

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

export type ClaimedKnowledgeCatalogExportJob = ClaimedDataExportJob<KnowledgeCatalogExportJob>;

export type AdvanceKnowledgeCatalogExportJobInput = AdvanceDataExportJobInput;

export type KnowledgeCatalogExportExpectedCursor = DataExportCursor;

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addSeconds(date: Date, seconds: number): string {
  return new Date(date.getTime() + seconds * 1000).toISOString();
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
