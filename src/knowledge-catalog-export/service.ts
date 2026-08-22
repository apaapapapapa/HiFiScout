import {
  createOrReuseKnowledgeCatalogExportJob,
  failKnowledgeCatalogExportJob,
  getKnowledgeCatalogExportJob,
  getLatestKnowledgeCatalogExportJob,
  reserveKnowledgeCatalogExportEnqueue,
  staleKnowledgeCatalogExportJobs,
} from "../db/knowledge-catalog-export-job-repository.js";
import { KNOWLEDGE_CATALOG_EXPORT_MAX_CHUNKS, knowledgeCatalogExportChunkKey } from "./csv.js";
import type { QueryableDatabase } from "../db/types.js";
import type { KnowledgeCatalogExportJob, KnowledgeCatalogExportQueueMessage } from "./types.js";

export type KnowledgeCatalogExportQueueProducer = Pick<
  Queue<KnowledgeCatalogExportQueueMessage>,
  "send"
>;

const KNOWLEDGE_CATALOG_EXPORT_STALE_ENQUEUE_SECONDS = 120;

function enqueueIsStale(job: KnowledgeCatalogExportJob, now: Date): boolean {
  const updatedAt = Date.parse(job.updatedAt);
  return (
    !Number.isFinite(updatedAt) ||
    updatedAt <= now.getTime() - KNOWLEDGE_CATALOG_EXPORT_STALE_ENQUEUE_SECONDS * 1000
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

function filename(job: KnowledgeCatalogExportJob): string {
  const date = /^\d{4}-\d{2}-\d{2}/u.exec(job.createdAt)?.[0] || "export";
  return `hifiscout-knowledge-catalog-${date}.csv`;
}

/** Starts the singleton bounded export, or throttles a recovery nudge for its current cursor. */
export async function startKnowledgeCatalogExport(
  db: QueryableDatabase,
  queue: KnowledgeCatalogExportQueueProducer,
  now: Date = new Date(),
): Promise<KnowledgeCatalogExportJob> {
  const created = await createOrReuseKnowledgeCatalogExportJob(db, crypto.randomUUID(), now);
  const message: KnowledgeCatalogExportQueueMessage = {
    kind: "knowledge_catalog_export",
    jobId: created.job.id,
    expectedAfterId: created.job.afterId,
    expectedChunkCount: created.job.chunkCount,
  };
  const shouldEnqueue =
    created.created ||
    (enqueueIsStale(created.job, now) &&
      (await reserveKnowledgeCatalogExportEnqueue(
        db,
        created.job.id,
        { afterId: created.job.afterId, chunkCount: created.job.chunkCount },
        now,
        KNOWLEDGE_CATALOG_EXPORT_STALE_ENQUEUE_SECONDS,
      )));
  if (!shouldEnqueue) return created.job;
  try {
    await queue.send(message);
  } catch (error) {
    if (created.created) {
      await failKnowledgeCatalogExportJob(
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

/** Recovers the singleton job when its last non-transactional D1/Queue send may have been lost. */
export async function recoverStaleKnowledgeCatalogExportJobs(
  db: QueryableDatabase,
  queue: KnowledgeCatalogExportQueueProducer,
  now: Date = new Date(),
): Promise<number> {
  const jobs = await staleKnowledgeCatalogExportJobs(
    db,
    now,
    KNOWLEDGE_CATALOG_EXPORT_STALE_ENQUEUE_SECONDS,
  );
  let enqueued = 0;
  for (const job of jobs) {
    const cursor = { afterId: job.afterId, chunkCount: job.chunkCount };
    const reserved = await reserveKnowledgeCatalogExportEnqueue(
      db,
      job.id,
      cursor,
      now,
      KNOWLEDGE_CATALOG_EXPORT_STALE_ENQUEUE_SECONDS,
    );
    if (!reserved) continue;
    try {
      await queue.send({
        kind: "knowledge_catalog_export",
        jobId: job.id,
        expectedAfterId: cursor.afterId,
        expectedChunkCount: cursor.chunkCount,
      });
      enqueued += 1;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "knowledge_catalog_export_stale_job_requeue_failed",
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  if (enqueued) {
    console.warn(
      JSON.stringify({ event: "knowledge_catalog_export_stale_jobs_requeued", enqueued }),
    );
  }
  return enqueued;
}

/** Status read plus a throttled nudge for the D1/Queue non-atomic send boundary. */
export async function latestKnowledgeCatalogExportJob(
  db: QueryableDatabase,
  queue: KnowledgeCatalogExportQueueProducer,
  now: Date = new Date(),
): Promise<KnowledgeCatalogExportJob | null> {
  const job = await getLatestKnowledgeCatalogExportJob(db, now);
  if (!job || (job.status !== "queued" && job.status !== "processing")) return job;
  if (!enqueueIsStale(job, now)) return job;
  const reserved = await reserveKnowledgeCatalogExportEnqueue(
    db,
    job.id,
    { afterId: job.afterId, chunkCount: job.chunkCount },
    now,
    KNOWLEDGE_CATALOG_EXPORT_STALE_ENQUEUE_SECONDS,
  );
  if (reserved) {
    await queue.send({
      kind: "knowledge_catalog_export",
      jobId: job.id,
      expectedAfterId: job.afterId,
      expectedChunkCount: job.chunkCount,
    });
  }
  return job;
}

function byteStreamFromChunks(
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
            object ||= await bucket.get(knowledgeCatalogExportChunkKey(jobId, chunkIndex));
            if (!object) throw new Error(`knowledge_catalog_export_chunk_missing:${chunkIndex}`);
            reader = object.body.getReader();
          }

          const result = await reader.read();
          if (!result.done) {
            if (!(result.value instanceof Uint8Array)) {
              throw new Error(`knowledge_catalog_export_chunk_not_bytes:${chunkIndex}`);
            }
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

/** Streams deterministic R2 chunks without concatenating the full attachment in Worker memory. */
export async function createKnowledgeCatalogExportDownloadResponse(
  db: QueryableDatabase,
  bucket: R2Bucket,
  jobId: string,
  now: Date = new Date(),
): Promise<Response> {
  const job = await getKnowledgeCatalogExportJob(db, jobId);
  if (!job) return jsonError("knowledge_catalog_export_not_found", 404);
  if (job.expiresAt <= now.toISOString()) {
    return jsonError("knowledge_catalog_export_expired", 410);
  }
  if (job.status !== "ready") {
    return jsonError(
      job.status === "failed"
        ? "knowledge_catalog_export_failed"
        : "knowledge_catalog_export_not_ready",
      409,
    );
  }
  if (job.chunkCount < 1) return jsonError("knowledge_catalog_export_chunks_missing", 503);
  if (job.chunkCount > KNOWLEDGE_CATALOG_EXPORT_MAX_CHUNKS) {
    return jsonError("knowledge_catalog_export_too_many_chunks", 503);
  }

  const firstObject = await bucket.get(knowledgeCatalogExportChunkKey(job.id, 0));
  if (!firstObject) return jsonError("knowledge_catalog_export_chunks_missing", 503);
  return new Response(byteStreamFromChunks(bucket, job.id, job.chunkCount, firstObject), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename(job)}"`,
      "content-length": String(job.byteCount),
      "cache-control": "no-store",
    },
  });
}

export { getKnowledgeCatalogExportJob };
