import {
  createOrReuseProductAuditExportJob,
  failProductAuditExportJob,
  getLatestProductAuditExportJob,
  getProductAuditExportJob,
  reserveProductAuditExportEnqueue,
  staleProductAuditExportJobs,
} from "../db/product-audit-export-job-repository.js";
import { PRODUCT_AUDIT_EXPORT_MAX_CHUNKS, productAuditExportChunkKey } from "./csv.js";
import type { QueryableDatabase } from "../db/types.js";
import type {
  ProductAuditExportJob,
  ProductAuditExportQueueMessage,
  ProductAuditExportScope,
} from "./types.js";

export type ProductAuditExportQueueProducer = Pick<Queue<ProductAuditExportQueueMessage>, "send">;

const PRODUCT_AUDIT_EXPORT_STALE_ENQUEUE_SECONDS = 120;

function productAuditExportEnqueueIsStale(job: ProductAuditExportJob, now: Date): boolean {
  const updatedAt = Date.parse(job.updatedAt);
  return (
    !Number.isFinite(updatedAt) ||
    updatedAt <= now.getTime() - PRODUCT_AUDIT_EXPORT_STALE_ENQUEUE_SECONDS * 1000
  );
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

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
    (productAuditExportEnqueueIsStale(created.job, now) &&
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
  if (!productAuditExportEnqueueIsStale(job, now)) return job;
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

function byteStreamFromProductAuditChunks(
  bucket: R2Bucket,
  jobId: string,
  chunkCount: number,
  firstObject: R2ObjectBody,
): ReadableStream<Uint8Array> {
  let chunkIndex = 0;
  let object: R2ObjectBody | null = firstObject;
  let reader: ReadableStreamDefaultReader | null = null;

  return new ReadableStream<Uint8Array>({
    type: "bytes",
    async pull(controller): Promise<void> {
      try {
        for (;;) {
          if (!reader) {
            if (chunkIndex >= chunkCount) {
              controller.close();
              return;
            }
            object ||= await bucket.get(productAuditExportChunkKey(jobId, chunkIndex));
            if (!object) throw new Error(`product_audit_export_chunk_missing:${chunkIndex}`);
            reader = object.body.getReader();
          }

          const result = await reader.read();
          if (!result.done) {
            if (!(result.value instanceof Uint8Array)) {
              throw new Error(`product_audit_export_chunk_not_bytes:${chunkIndex}`);
            }
            // A byte controller requires an ArrayBuffer-backed view. R2 may expose the wider
            // ArrayBufferLike generic, so copy the bounded stream chunk into a transferable view.
            const bytes = new Uint8Array(new ArrayBuffer(result.value.byteLength));
            bytes.set(result.value);
            controller.enqueue(bytes);
            return;
          }

          reader.releaseLock();
          reader = null;
          object = null;
          chunkIndex += 1;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason): Promise<void> {
      if (reader) await reader.cancel(reason);
    },
  });
}

/**
 * Produces the actual attachment without concatenating its R2 chunks in Worker memory.
 */
export async function createProductAuditExportDownloadResponse(
  db: QueryableDatabase,
  bucket: R2Bucket,
  jobId: string,
  now: Date = new Date(),
): Promise<Response> {
  const job = await getProductAuditExportJob(db, jobId);
  if (!job) return jsonError("product_audit_export_not_found", 404);
  if (job.expiresAt && job.expiresAt <= now.toISOString()) {
    return jsonError("product_audit_export_expired", 410);
  }
  if (job.status !== "ready") {
    return jsonError(
      job.status === "failed" ? "product_audit_export_failed" : "product_audit_export_not_ready",
      409,
    );
  }
  if (job.chunkCount < 1) return jsonError("product_audit_export_chunks_missing", 503);
  if (job.chunkCount > PRODUCT_AUDIT_EXPORT_MAX_CHUNKS) {
    return jsonError("product_audit_export_too_many_chunks", 503);
  }

  // Fetch only the first object before committing the HTTP status. Remaining objects are fetched
  // on demand by the byte stream, keeping both memory and simultaneous R2 bodies bounded at one.
  const firstObject = await bucket.get(productAuditExportChunkKey(job.id, 0));
  if (!firstObject) return jsonError("product_audit_export_chunks_missing", 503);

  return new Response(
    byteStreamFromProductAuditChunks(bucket, job.id, job.chunkCount, firstObject),
    {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${productAuditExportFilename(job)}"`,
        "content-length": String(job.byteCount),
        "cache-control": "no-store",
      },
    },
  );
}

export { getLatestProductAuditExportJob, getProductAuditExportJob };
