import {
  createOrReuseProductAuditExportJob,
  failProductAuditExportJob,
  getLatestProductAuditExportJob,
  getProductAuditExportJob,
  reserveProductAuditExportEnqueue,
  staleProductAuditExportJobs,
} from "../db/product-audit-export-job-repository.js";
import type { QueryableDatabase } from "../db/types.js";
import { createCsvExportDownloadResponse, exportEnqueueIsStale } from "../export/service.js";
import { PRODUCT_AUDIT_EXPORT_MAX_CHUNKS, productAuditExportChunkKey } from "./csv.js";
import type {
  ProductAuditExportJob,
  ProductAuditExportQueueMessage,
  ProductAuditExportScope,
} from "./types.js";

export type ProductAuditExportQueueProducer = Pick<Queue<ProductAuditExportQueueMessage>, "send">;

const PRODUCT_AUDIT_EXPORT_STALE_ENQUEUE_SECONDS = 120;

function productAuditExportFilename(job: ProductAuditExportJob): string {
  const date = /^\d{4}-\d{2}-\d{2}/u.exec(job.createdAt)?.[0] || "export";
  return `hifiscout-product-audit-${job.scope}-${date}.csv`;
}

/** Starts a new bounded export, or throttles a recovery nudge for the in-flight scope. */
export async function startProductAuditExport(
  db: QueryableDatabase,
  queue: ProductAuditExportQueueProducer,
  scope: ProductAuditExportScope,
  now: Date = new Date(),
): Promise<ProductAuditExportJob> {
  if (scope !== "active" && scope !== "all") {
    throw new Error("invalid_product_audit_export_scope");
  }
  const created = await createOrReuseProductAuditExportJob(db, scope, crypto.randomUUID(), now);
  const message: ProductAuditExportQueueMessage = {
    kind: "product_audit_export",
    jobId: created.job.id,
    expectedAfterId: created.job.afterId,
    expectedChunkCount: created.job.chunkCount,
  };
  const shouldEnqueue =
    created.created ||
    (exportEnqueueIsStale(created.job.updatedAt, now, PRODUCT_AUDIT_EXPORT_STALE_ENQUEUE_SECONDS) &&
      (await reserveProductAuditExportEnqueue(
        db,
        created.job.id,
        { afterId: created.job.afterId, chunkCount: created.job.chunkCount },
        now,
        PRODUCT_AUDIT_EXPORT_STALE_ENQUEUE_SECONDS,
      )));
  if (!shouldEnqueue) return created.job;
  try {
    // Re-sending a reused cursor recovers the narrow crash window between its INSERT and send().
    // The consumer's cursor CAS makes the duplicate harmless when a delivery already exists.
    await queue.send(message);
  } catch (error) {
    if (created.created) {
      await failProductAuditExportJob(
        db,
        created.job.id,
        `queue_enqueue_failed:${error instanceof Error ? error.message : String(error)}`,
        now,
      );
    }
    throw error;
  }
  return created.job;
}

/** Recovers the bounded set of scope-level jobs whose last Queue send may have been lost. */
export async function recoverStaleProductAuditExportJobs(
  db: QueryableDatabase,
  queue: ProductAuditExportQueueProducer,
  now: Date = new Date(),
): Promise<number> {
  const jobs = await staleProductAuditExportJobs(
    db,
    now,
    PRODUCT_AUDIT_EXPORT_STALE_ENQUEUE_SECONDS,
  );
  let enqueued = 0;
  for (const job of jobs) {
    const cursor = { afterId: job.afterId, chunkCount: job.chunkCount };
    const reserved = await reserveProductAuditExportEnqueue(
      db,
      job.id,
      cursor,
      now,
      PRODUCT_AUDIT_EXPORT_STALE_ENQUEUE_SECONDS,
    );
    if (!reserved) continue;
    try {
      await queue.send({
        kind: "product_audit_export",
        jobId: job.id,
        expectedAfterId: cursor.afterId,
        expectedChunkCount: cursor.chunkCount,
      });
      enqueued += 1;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "product_audit_export_stale_job_requeue_failed",
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  if (enqueued) {
    console.warn(JSON.stringify({ event: "product_audit_export_stale_jobs_requeued", enqueued }));
  }
  return enqueued;
}

/** Status read plus a throttled recovery nudge for the D1/Queue non-atomic send boundary. */
export async function latestProductAuditExportJob(
  db: QueryableDatabase,
  queue: ProductAuditExportQueueProducer,
  scope: ProductAuditExportScope,
  now: Date = new Date(),
): Promise<ProductAuditExportJob | null> {
  const job = await getLatestProductAuditExportJob(db, scope, now);
  if (!job || (job.status !== "queued" && job.status !== "processing")) return job;
  if (!exportEnqueueIsStale(job.updatedAt, now, PRODUCT_AUDIT_EXPORT_STALE_ENQUEUE_SECONDS)) {
    return job;
  }
  const reserved = await reserveProductAuditExportEnqueue(
    db,
    job.id,
    { afterId: job.afterId, chunkCount: job.chunkCount },
    now,
    PRODUCT_AUDIT_EXPORT_STALE_ENQUEUE_SECONDS,
  );
  if (reserved) {
    await queue.send({
      kind: "product_audit_export",
      jobId: job.id,
      expectedAfterId: job.afterId,
      expectedChunkCount: job.chunkCount,
    });
  }
  return job;
}

/** Produces the CSV attachment while keeping only one R2 chunk body open at a time. */
export async function createProductAuditExportDownloadResponse(
  db: QueryableDatabase,
  bucket: R2Bucket,
  jobId: string,
  now: Date = new Date(),
): Promise<Response> {
  return createCsvExportDownloadResponse(
    await getProductAuditExportJob(db, jobId),
    bucket,
    {
      errorPrefix: "product_audit_export",
      maxChunks: PRODUCT_AUDIT_EXPORT_MAX_CHUNKS,
      chunkKey: productAuditExportChunkKey,
      filename: productAuditExportFilename,
    },
    now,
  );
}

export { getLatestProductAuditExportJob, getProductAuditExportJob };
