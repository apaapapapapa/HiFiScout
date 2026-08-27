import {
  createOrReuseKnowledgeCatalogExportJob,
  failKnowledgeCatalogExportJob,
  getKnowledgeCatalogExportJob,
  getLatestKnowledgeCatalogExportJob,
  reserveKnowledgeCatalogExportEnqueue,
  staleKnowledgeCatalogExportJobs,
} from "../db/knowledge-catalog-export-job-repository.js";
import type { QueryableDatabase } from "../db/types.js";
import { createCsvExportDownloadResponse, exportEnqueueIsStale } from "../export/service.js";
import { KNOWLEDGE_CATALOG_EXPORT_MAX_CHUNKS, knowledgeCatalogExportChunkKey } from "./csv.js";
import type { KnowledgeCatalogExportJob, KnowledgeCatalogExportQueueMessage } from "./types.js";

export type KnowledgeCatalogExportQueueProducer = Pick<
  Queue<KnowledgeCatalogExportQueueMessage>,
  "send"
>;

const KNOWLEDGE_CATALOG_EXPORT_STALE_ENQUEUE_SECONDS = 120;

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
    (exportEnqueueIsStale(
      created.job.updatedAt,
      now,
      KNOWLEDGE_CATALOG_EXPORT_STALE_ENQUEUE_SECONDS,
    ) &&
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
  if (!exportEnqueueIsStale(job.updatedAt, now, KNOWLEDGE_CATALOG_EXPORT_STALE_ENQUEUE_SECONDS)) {
    return job;
  }
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

/** Streams deterministic R2 chunks without concatenating the full attachment in Worker memory. */
export async function createKnowledgeCatalogExportDownloadResponse(
  db: QueryableDatabase,
  bucket: R2Bucket,
  jobId: string,
  now: Date = new Date(),
): Promise<Response> {
  return createCsvExportDownloadResponse(
    await getKnowledgeCatalogExportJob(db, jobId),
    bucket,
    {
      errorPrefix: "knowledge_catalog_export",
      maxChunks: KNOWLEDGE_CATALOG_EXPORT_MAX_CHUNKS,
      chunkKey: knowledgeCatalogExportChunkKey,
      filename,
    },
    now,
  );
}

export { getKnowledgeCatalogExportJob };
