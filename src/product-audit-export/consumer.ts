import {
  advanceProductAuditExportJob,
  claimProductAuditExportJob,
  failClaimedProductAuditExportJob,
  failProductAuditExportJob,
  failQueuedProductAuditExportJob,
  getProductAuditExportLeaseExpiry,
  getProductAuditExportJob,
  releaseProductAuditExportJobClaim,
} from "../db/product-audit-export-job-repository.js";
import { listProductAuditExportPage } from "../db/product-audit-export-repository.js";
import {
  encodeProductAuditExportChunk,
  PRODUCT_AUDIT_EXPORT_MAX_CHUNKS,
  PRODUCT_AUDIT_EXPORT_PAGE_SIZE,
  productAuditExportChunkKey,
} from "./csv.js";
import { isProductAuditExportQueueMessage } from "./types.js";
import type { ClaimedProductAuditExportJob } from "../db/product-audit-export-job-repository.js";
import type { QueryableDatabase } from "../db/types.js";
import type { ProductAuditExportJob, ProductAuditExportQueueMessage } from "./types.js";

const PRODUCT_AUDIT_EXPORT_CONTINUATION_DELAY_SECONDS = 5;
const PRODUCT_AUDIT_EXPORT_BUSY_RETRY_DELAY_SECONDS = 15;
const PRODUCT_AUDIT_EXPORT_ERROR_RETRY_DELAY_SECONDS = 30;
const PRODUCT_AUDIT_EXPORT_LEASE_SECONDS = 60;
const CHUNK_METADATA_VERSION = "1";

export interface ProductAuditExportConsumerEnv {
  DB: QueryableDatabase;
  EVIDENCE_BUCKET: R2Bucket;
  PRODUCT_AUDIT_EXPORT_QUEUE: Pick<Queue<ProductAuditExportQueueMessage>, "send">;
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
  job: ProductAuditExportJob,
  message: ProductAuditExportQueueMessage,
): StoredChunk {
  const metadata = object.customMetadata || {};
  const afterId = integerMetadata(metadata, "afterId");
  const chunkIndex = integerMetadata(metadata, "chunkIndex");
  const maxListingId = integerMetadata(metadata, "maxListingId");
  const nextAfterId = integerMetadata(metadata, "nextAfterId");
  const rowCount = integerMetadata(metadata, "rowCount");
  const hasMore = metadata.hasMore === "1";
  if (
    metadata.version !== CHUNK_METADATA_VERSION ||
    metadata.scope !== job.scope ||
    afterId !== message.expectedAfterId ||
    chunkIndex !== message.expectedChunkCount ||
    maxListingId !== job.maxListingId ||
    nextAfterId === null ||
    rowCount === null ||
    (metadata.hasMore !== "0" && metadata.hasMore !== "1") ||
    (hasMore && nextAfterId <= message.expectedAfterId) ||
    nextAfterId > job.maxListingId
  ) {
    throw new Error(`product_audit_export_chunk_metadata_invalid:${object.key}`);
  }
  return {
    key: object.key,
    nextAfterId,
    rowCount,
    byteCount: object.size,
    hasMore,
  };
}

/** Writes or reuses the deterministic chunk for one and only one bounded page. */
async function ensureProductAuditExportChunk(
  env: ProductAuditExportConsumerEnv,
  job: ProductAuditExportJob,
  message: ProductAuditExportQueueMessage,
): Promise<StoredChunk> {
  const key = productAuditExportChunkKey(job.id, message.expectedChunkCount);
  const existing = await env.EVIDENCE_BUCKET.head(key);
  if (existing) return storedChunkFromObject(existing, job, message);

  const page = await listProductAuditExportPage(env.DB, {
    scope: job.scope,
    afterId: message.expectedAfterId,
    maxId: job.maxListingId,
    limit: PRODUCT_AUDIT_EXPORT_PAGE_SIZE,
  });
  const lastListingId = page.items.at(-1)?.listingId ?? message.expectedAfterId;
  const hasMore = page.nextAfterId !== null;
  const nextAfterId = page.nextAfterId ?? lastListingId;
  if (
    nextAfterId < message.expectedAfterId ||
    nextAfterId > job.maxListingId ||
    (hasMore && nextAfterId <= message.expectedAfterId)
  ) {
    throw new Error("product_audit_export_cursor_did_not_advance");
  }

  const bytes = encodeProductAuditExportChunk(page.items, message.expectedChunkCount);
  const customMetadata = {
    version: CHUNK_METADATA_VERSION,
    scope: job.scope,
    afterId: String(message.expectedAfterId),
    chunkIndex: String(message.expectedChunkCount),
    maxListingId: String(job.maxListingId),
    nextAfterId: String(nextAfterId),
    rowCount: String(page.items.length),
    hasMore: hasMore ? "1" : "0",
  };
  const object = await env.EVIDENCE_BUCKET.put(key, bytes, {
    // A worker whose lease expired must not overwrite a chunk another claimant already committed.
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "text/csv; charset=utf-8" },
    customMetadata,
  });
  if (object) {
    return {
      key,
      nextAfterId,
      rowCount: page.items.length,
      byteCount: object.size,
      hasMore,
    };
  }

  // A conditional-write loser adopts the winner's cursor metadata instead of querying the page
  // again, which keeps recovery deterministic even if a listing changes during the job.
  const winner = await env.EVIDENCE_BUCKET.head(key);
  if (!winner) throw new Error(`product_audit_export_chunk_write_lost:${key}`);
  return storedChunkFromObject(winner, job, message);
}

function retryUnclaimableMessage(
  message: Message<ProductAuditExportQueueMessage>,
  job: ProductAuditExportJob,
): "acked" | "retried" {
  const body = message.body;
  const cursorIsPastMessage =
    job.chunkCount > body.expectedChunkCount ||
    (job.chunkCount === body.expectedChunkCount && job.afterId > body.expectedAfterId);
  if (job.status === "ready" || job.status === "failed" || cursorIsPastMessage) {
    message.ack();
    return "acked";
  }
  // Ten configured retries at this delay span well beyond the 60-second lease. A delivery from a
  // crashed claimant can therefore become claimable again before it is moved to the DLQ.
  message.retry({ delaySeconds: PRODUCT_AUDIT_EXPORT_BUSY_RETRY_DELAY_SECONDS });
  return "retried";
}

export async function consumeProductAuditExportMessage(
  env: ProductAuditExportConsumerEnv,
  message: Message<ProductAuditExportQueueMessage>,
): Promise<{ status: "completed" | "continued" | "failed" | "ignored" | "retrying" }> {
  if (!isProductAuditExportQueueMessage(message.body)) {
    console.error(
      JSON.stringify({ event: "product_audit_export_invalid_message", body: message.body }),
    );
    message.ack();
    return { status: "ignored" };
  }

  const body = message.body;
  let claim: ClaimedProductAuditExportJob | null = null;
  try {
    const claimedAt = new Date();
    claim = await claimProductAuditExportJob(
      env.DB,
      body.jobId,
      body.expectedAfterId,
      body.expectedChunkCount,
      claimedAt,
      PRODUCT_AUDIT_EXPORT_LEASE_SECONDS,
    );
    if (!claim) {
      const current = await getProductAuditExportJob(env.DB, body.jobId);
      if (!current) {
        message.ack();
        return { status: "ignored" };
      }
      const observedAt = new Date();
      if (
        (current.status === "queued" || current.status === "processing") &&
        current.expiresAt &&
        current.expiresAt <= observedAt.toISOString()
      ) {
        await failProductAuditExportJob(
          env.DB,
          current.id,
          "product_audit_export_generation_deadline_exceeded",
          observedAt,
          { afterId: body.expectedAfterId, chunkCount: body.expectedChunkCount },
        );
        message.ack();
        return { status: "failed" };
      }
      const action = retryUnclaimableMessage(message, current);
      return { status: action === "acked" ? "ignored" : "retrying" };
    }

    const chunk = await ensureProductAuditExportChunk(env, claim.job, body);
    if (chunk.hasMore && body.expectedChunkCount + 1 >= PRODUCT_AUDIT_EXPORT_MAX_CHUNKS) {
      const failed = await failClaimedProductAuditExportJob(
        env.DB,
        claim.job.id,
        claim.leaseToken,
        "product_audit_export_too_large",
        new Date(),
        { afterId: body.expectedAfterId, chunkCount: body.expectedChunkCount },
      );
      if (!failed) {
        message.retry({ delaySeconds: PRODUCT_AUDIT_EXPORT_CONTINUATION_DELAY_SECONDS });
        return { status: "retrying" };
      }
      message.ack();
      console.error(
        JSON.stringify({
          event: "product_audit_export_size_limit_exceeded",
          jobId: claim.job.id,
          chunkIndex: body.expectedChunkCount,
        }),
      );
      return { status: "failed" };
    }
    if (chunk.hasMore) {
      // Queue first, D1 second: after any interruption, either the old cursor is retried or at
      // least one continuation exists. The reverse order could permanently strand the job.
      await env.PRODUCT_AUDIT_EXPORT_QUEUE.send(
        {
          kind: "product_audit_export",
          jobId: claim.job.id,
          expectedAfterId: chunk.nextAfterId,
          expectedChunkCount: body.expectedChunkCount + 1,
        },
        { delaySeconds: PRODUCT_AUDIT_EXPORT_CONTINUATION_DELAY_SECONDS },
      );
    }

    const advanced = await advanceProductAuditExportJob(env.DB, {
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
      message.retry({ delaySeconds: PRODUCT_AUDIT_EXPORT_CONTINUATION_DELAY_SECONDS });
      return { status: "retrying" };
    }

    message.ack();
    console.log(
      JSON.stringify({
        event: chunk.hasMore
          ? "product_audit_export_chunk_completed"
          : "product_audit_export_ready",
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
        await releaseProductAuditExportJobClaim(
          env.DB,
          claim.job.id,
          claim.leaseToken,
          new Date(),
          `delivery_error:${errorMessage(error)}`,
        );
      } catch (releaseError) {
        console.error(
          JSON.stringify({
            event: "product_audit_export_claim_release_failed",
            jobId: claim.job.id,
            error: errorMessage(releaseError),
          }),
        );
      }
    }
    message.retry({ delaySeconds: PRODUCT_AUDIT_EXPORT_ERROR_RETRY_DELAY_SECONDS });
    console.error(
      JSON.stringify({
        event: "product_audit_export_delivery_retry",
        jobId: body.jobId,
        chunkIndex: body.expectedChunkCount,
        error: errorMessage(error),
      }),
    );
    return { status: "retrying" };
  }
}

/** Processes messages sequentially so one delivery can consume at most one bounded CPU slice. */
export async function consumeProductAuditExportBatch(
  env: ProductAuditExportConsumerEnv,
  batch: MessageBatch<ProductAuditExportQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    await consumeProductAuditExportMessage(env, message);
  }
}

/** Marks delivery-exhausted jobs failed and acknowledges each DLQ message independently. */
export async function consumeProductAuditExportDeadLetterBatch(
  env: ProductAuditExportConsumerEnv,
  batch: MessageBatch<ProductAuditExportQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    if (!isProductAuditExportQueueMessage(message.body)) {
      message.ack();
      continue;
    }
    try {
      const current = await getProductAuditExportJob(env.DB, message.body.jobId);
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
        const leaseExpiresAt = await getProductAuditExportLeaseExpiry(env.DB, current.id, {
          afterId: message.body.expectedAfterId,
          chunkCount: message.body.expectedChunkCount,
        });
        const remainingLeaseSeconds = leaseExpiresAt
          ? Math.ceil((Date.parse(leaseExpiresAt) - now.getTime()) / 1000)
          : 0;
        const delaySeconds = Math.max(
          PRODUCT_AUDIT_EXPORT_CONTINUATION_DELAY_SECONDS,
          Number.isFinite(remainingLeaseSeconds) ? remainingLeaseSeconds + 1 : 0,
        );
        // A live claimant may still commit this cursor. If it crashed, this delayed main-queue
        // delivery takes over after the lease; if it succeeds, the delivery is stale and acked.
        await env.PRODUCT_AUDIT_EXPORT_QUEUE.send(message.body, { delaySeconds });
        console.warn(
          JSON.stringify({
            event: "product_audit_export_dead_letter_requeued",
            jobId: current.id,
            chunkIndex: message.body.expectedChunkCount,
            delaySeconds,
          }),
        );
        message.ack();
        continue;
      }
      const failed = await failQueuedProductAuditExportJob(
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
        // A main-queue worker may have claimed the cursor after our SELECT. The queued-only CAS
        // deliberately loses that race; retrying lets the next DLQ pass observe the new state.
        message.retry({ delaySeconds: PRODUCT_AUDIT_EXPORT_BUSY_RETRY_DELAY_SECONDS });
        continue;
      }
      console.error(
        JSON.stringify({
          event: "product_audit_export_dead_letter",
          jobId: message.body.jobId,
          chunkIndex: message.body.expectedChunkCount,
        }),
      );
      message.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "product_audit_export_dead_letter_retry",
          jobId: message.body.jobId,
          error: errorMessage(error),
        }),
      );
      message.retry({ delaySeconds: PRODUCT_AUDIT_EXPORT_ERROR_RETRY_DELAY_SECONDS });
    }
  }
}
