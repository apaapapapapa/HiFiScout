import {
  advanceKnowledgeCatalogExportJob,
  claimKnowledgeCatalogExportJob,
  failClaimedKnowledgeCatalogExportJob,
  failKnowledgeCatalogExportJob,
  failQueuedKnowledgeCatalogExportJob,
  getKnowledgeCatalogExportJob,
  getKnowledgeCatalogExportLeaseExpiry,
  releaseKnowledgeCatalogExportJobClaim,
} from "../db/knowledge-catalog-export-job-repository.js";
import { listKnowledgeCatalogExportPage } from "../db/knowledge-catalog-export-repository.js";
import {
  encodeKnowledgeCatalogExportChunk,
  KNOWLEDGE_CATALOG_EXPORT_MAX_CHUNKS,
  KNOWLEDGE_CATALOG_EXPORT_PAGE_SIZE,
  knowledgeCatalogExportChunkKey,
} from "./csv.js";
import { isKnowledgeCatalogExportQueueMessage } from "./types.js";
import type { ClaimedKnowledgeCatalogExportJob } from "../db/knowledge-catalog-export-job-repository.js";
import type { QueryableDatabase } from "../db/types.js";
import type { KnowledgeCatalogExportJob, KnowledgeCatalogExportQueueMessage } from "./types.js";

const CONTINUATION_DELAY_SECONDS = 5;
const BUSY_RETRY_DELAY_SECONDS = 15;
const ERROR_RETRY_DELAY_SECONDS = 30;
const LEASE_SECONDS = 60;
const CHUNK_METADATA_VERSION = "1";

export interface KnowledgeCatalogExportConsumerEnv {
  DB: QueryableDatabase;
  EVIDENCE_BUCKET: R2Bucket;
  PRODUCT_AUDIT_EXPORT_QUEUE: Pick<Queue<KnowledgeCatalogExportQueueMessage>, "send">;
}

interface StoredChunk {
  key: string;
  nextAfterId: number;
  rowCount: number;
  byteCount: number;
  hasMore: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function integerMetadata(metadata: Record<string, string>, key: string): number | null {
  const value = Number(metadata[key]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function storedChunkFromObject(
  object: R2Object,
  job: KnowledgeCatalogExportJob,
  message: KnowledgeCatalogExportQueueMessage,
): StoredChunk {
  const metadata = object.customMetadata || {};
  const afterId = integerMetadata(metadata, "afterId");
  const chunkIndex = integerMetadata(metadata, "chunkIndex");
  const maxCatalogProductId = integerMetadata(metadata, "maxCatalogProductId");
  const nextAfterId = integerMetadata(metadata, "nextAfterId");
  const rowCount = integerMetadata(metadata, "rowCount");
  const hasMore = metadata.hasMore === "1";
  if (
    metadata.version !== CHUNK_METADATA_VERSION ||
    afterId !== message.expectedAfterId ||
    chunkIndex !== message.expectedChunkCount ||
    maxCatalogProductId !== job.maxCatalogProductId ||
    nextAfterId === null ||
    rowCount === null ||
    (metadata.hasMore !== "0" && metadata.hasMore !== "1") ||
    (hasMore && nextAfterId <= message.expectedAfterId) ||
    nextAfterId > job.maxCatalogProductId
  ) {
    throw new Error(`knowledge_catalog_export_chunk_metadata_invalid:${object.key}`);
  }
  return { key: object.key, nextAfterId, rowCount, byteCount: object.size, hasMore };
}

async function ensureChunk(
  env: KnowledgeCatalogExportConsumerEnv,
  job: KnowledgeCatalogExportJob,
  message: KnowledgeCatalogExportQueueMessage,
): Promise<StoredChunk> {
  const key = knowledgeCatalogExportChunkKey(job.id, message.expectedChunkCount);
  const existing = await env.EVIDENCE_BUCKET.head(key);
  if (existing) return storedChunkFromObject(existing, job, message);

  const page = await listKnowledgeCatalogExportPage(env.DB, {
    afterId: message.expectedAfterId,
    maxId: job.maxCatalogProductId,
    limit: KNOWLEDGE_CATALOG_EXPORT_PAGE_SIZE,
  });
  const lastCatalogProductId = page.items.at(-1)?.catalogProductId ?? message.expectedAfterId;
  const hasMore = page.nextAfterId !== null;
  const nextAfterId = page.nextAfterId ?? lastCatalogProductId;
  if (
    nextAfterId < message.expectedAfterId ||
    nextAfterId > job.maxCatalogProductId ||
    (hasMore && nextAfterId <= message.expectedAfterId)
  ) {
    throw new Error("knowledge_catalog_export_cursor_did_not_advance");
  }

  const bytes = encodeKnowledgeCatalogExportChunk(page.items, message.expectedChunkCount);
  const customMetadata = {
    version: CHUNK_METADATA_VERSION,
    afterId: String(message.expectedAfterId),
    chunkIndex: String(message.expectedChunkCount),
    maxCatalogProductId: String(job.maxCatalogProductId),
    nextAfterId: String(nextAfterId),
    rowCount: String(page.items.length),
    hasMore: hasMore ? "1" : "0",
  };
  const object = await env.EVIDENCE_BUCKET.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "text/csv; charset=utf-8" },
    customMetadata,
  });
  if (object) {
    return { key, nextAfterId, rowCount: page.items.length, byteCount: object.size, hasMore };
  }
  const winner = await env.EVIDENCE_BUCKET.head(key);
  if (!winner) throw new Error(`knowledge_catalog_export_chunk_write_lost:${key}`);
  return storedChunkFromObject(winner, job, message);
}

function retryUnclaimableMessage(
  message: Message<KnowledgeCatalogExportQueueMessage>,
  job: KnowledgeCatalogExportJob,
): "acked" | "retried" {
  const cursorIsPastMessage =
    job.chunkCount > message.body.expectedChunkCount ||
    (job.chunkCount === message.body.expectedChunkCount &&
      job.afterId > message.body.expectedAfterId);
  if (job.status === "ready" || job.status === "failed" || cursorIsPastMessage) {
    message.ack();
    return "acked";
  }
  message.retry({ delaySeconds: BUSY_RETRY_DELAY_SECONDS });
  return "retried";
}

export async function consumeKnowledgeCatalogExportMessage(
  env: KnowledgeCatalogExportConsumerEnv,
  message: Message<KnowledgeCatalogExportQueueMessage>,
): Promise<{ status: "completed" | "continued" | "failed" | "ignored" | "retrying" }> {
  if (!isKnowledgeCatalogExportQueueMessage(message.body)) {
    console.error(
      JSON.stringify({ event: "knowledge_catalog_export_invalid_message", body: message.body }),
    );
    message.ack();
    return { status: "ignored" };
  }

  const body = message.body;
  let claim: ClaimedKnowledgeCatalogExportJob | null = null;
  try {
    const claimedAt = new Date();
    claim = await claimKnowledgeCatalogExportJob(
      env.DB,
      body.jobId,
      body.expectedAfterId,
      body.expectedChunkCount,
      claimedAt,
      LEASE_SECONDS,
    );
    if (!claim) {
      const current = await getKnowledgeCatalogExportJob(env.DB, body.jobId);
      if (!current) {
        message.ack();
        return { status: "ignored" };
      }
      const observedAt = new Date();
      if (
        (current.status === "queued" || current.status === "processing") &&
        current.expiresAt <= observedAt.toISOString()
      ) {
        await failKnowledgeCatalogExportJob(
          env.DB,
          current.id,
          "knowledge_catalog_export_generation_deadline_exceeded",
          observedAt,
          { afterId: body.expectedAfterId, chunkCount: body.expectedChunkCount },
        );
        message.ack();
        return { status: "failed" };
      }
      const action = retryUnclaimableMessage(message, current);
      return { status: action === "acked" ? "ignored" : "retrying" };
    }

    const chunk = await ensureChunk(env, claim.job, body);
    if (chunk.hasMore && body.expectedChunkCount + 1 >= KNOWLEDGE_CATALOG_EXPORT_MAX_CHUNKS) {
      const failed = await failClaimedKnowledgeCatalogExportJob(
        env.DB,
        claim.job.id,
        claim.leaseToken,
        "knowledge_catalog_export_too_large",
        new Date(),
        { afterId: body.expectedAfterId, chunkCount: body.expectedChunkCount },
      );
      if (!failed) {
        message.retry({ delaySeconds: CONTINUATION_DELAY_SECONDS });
        return { status: "retrying" };
      }
      message.ack();
      console.error(
        JSON.stringify({
          event: "knowledge_catalog_export_size_limit_exceeded",
          jobId: claim.job.id,
          chunkIndex: body.expectedChunkCount,
        }),
      );
      return { status: "failed" };
    }
    if (chunk.hasMore) {
      await env.PRODUCT_AUDIT_EXPORT_QUEUE.send(
        {
          kind: "knowledge_catalog_export",
          jobId: claim.job.id,
          expectedAfterId: chunk.nextAfterId,
          expectedChunkCount: body.expectedChunkCount + 1,
        },
        { delaySeconds: CONTINUATION_DELAY_SECONDS },
      );
    }

    const advanced = await advanceKnowledgeCatalogExportJob(env.DB, {
      jobId: claim.job.id,
      leaseToken: claim.leaseToken,
      expectedAfterId: body.expectedAfterId,
      expectedChunkCount: body.expectedChunkCount,
      nextAfterId: chunk.nextAfterId,
      addedRows: chunk.rowCount,
      addedBytes: chunk.byteCount,
      hasMore: chunk.hasMore,
      advancedAt: new Date(),
    });
    if (!advanced) {
      message.retry({ delaySeconds: CONTINUATION_DELAY_SECONDS });
      return { status: "retrying" };
    }

    message.ack();
    console.log(
      JSON.stringify({
        event: chunk.hasMore
          ? "knowledge_catalog_export_chunk_completed"
          : "knowledge_catalog_export_ready",
        jobId: claim.job.id,
        chunkIndex: body.expectedChunkCount,
        rows: chunk.rowCount,
        bytes: chunk.byteCount,
        nextAfterId: chunk.nextAfterId,
      }),
    );
    return { status: chunk.hasMore ? "continued" : "completed" };
  } catch (error) {
    if (claim) {
      try {
        await releaseKnowledgeCatalogExportJobClaim(
          env.DB,
          claim.job.id,
          claim.leaseToken,
          new Date(),
          `delivery_error:${errorMessage(error)}`,
        );
      } catch (releaseError) {
        console.error(
          JSON.stringify({
            event: "knowledge_catalog_export_claim_release_failed",
            jobId: claim.job.id,
            error: errorMessage(releaseError),
          }),
        );
      }
    }
    message.retry({ delaySeconds: ERROR_RETRY_DELAY_SECONDS });
    console.error(
      JSON.stringify({
        event: "knowledge_catalog_export_delivery_retry",
        jobId: body.jobId,
        chunkIndex: body.expectedChunkCount,
        error: errorMessage(error),
      }),
    );
    return { status: "retrying" };
  }
}

/** Sequential processing keeps each delivery to one bounded CPU slice. */
export async function consumeKnowledgeCatalogExportBatch(
  env: KnowledgeCatalogExportConsumerEnv,
  batch: MessageBatch<KnowledgeCatalogExportQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) await consumeKnowledgeCatalogExportMessage(env, message);
}

export async function consumeKnowledgeCatalogExportDeadLetterBatch(
  env: KnowledgeCatalogExportConsumerEnv,
  batch: MessageBatch<KnowledgeCatalogExportQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    if (!isKnowledgeCatalogExportQueueMessage(message.body)) {
      message.ack();
      continue;
    }
    try {
      const current = await getKnowledgeCatalogExportJob(env.DB, message.body.jobId);
      if (
        !current ||
        current.status === "ready" ||
        current.status === "failed" ||
        current.afterId !== message.body.expectedAfterId ||
        current.chunkCount !== message.body.expectedChunkCount
      ) {
        message.ack();
        continue;
      }
      if (current.status === "processing") {
        const now = new Date();
        const leaseExpiresAt = await getKnowledgeCatalogExportLeaseExpiry(env.DB, current.id, {
          afterId: message.body.expectedAfterId,
          chunkCount: message.body.expectedChunkCount,
        });
        const remainingLeaseSeconds = leaseExpiresAt
          ? Math.ceil((Date.parse(leaseExpiresAt) - now.getTime()) / 1000)
          : 0;
        const delaySeconds = Math.max(
          CONTINUATION_DELAY_SECONDS,
          Number.isFinite(remainingLeaseSeconds) ? remainingLeaseSeconds + 1 : 0,
        );
        await env.PRODUCT_AUDIT_EXPORT_QUEUE.send(message.body, { delaySeconds });
        console.warn(
          JSON.stringify({
            event: "knowledge_catalog_export_dead_letter_requeued",
            jobId: current.id,
            chunkIndex: message.body.expectedChunkCount,
            delaySeconds,
          }),
        );
        message.ack();
        continue;
      }
      const failed = await failQueuedKnowledgeCatalogExportJob(
        env.DB,
        message.body.jobId,
        "queue_delivery_exhausted",
        new Date(),
        {
          afterId: message.body.expectedAfterId,
          chunkCount: message.body.expectedChunkCount,
        },
      );
      if (!failed) {
        message.retry({ delaySeconds: BUSY_RETRY_DELAY_SECONDS });
        continue;
      }
      console.error(
        JSON.stringify({
          event: "knowledge_catalog_export_dead_letter",
          jobId: message.body.jobId,
          chunkIndex: message.body.expectedChunkCount,
        }),
      );
      message.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "knowledge_catalog_export_dead_letter_retry",
          jobId: message.body.jobId,
          error: errorMessage(error),
        }),
      );
      message.retry({ delaySeconds: ERROR_RETRY_DELAY_SECONDS });
    }
  }
}
