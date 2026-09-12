import type { QueryableDatabase } from "../db/types.js";
import { isDataExportQueueMessage } from "./contracts.js";
import type {
  AdvanceDataExportJobInput,
  ClaimedDataExportJob,
  DataExportCursor,
  DataExportJob,
  DataExportKind,
  DataExportQueueMessage,
  StoredDataExportChunk,
} from "./contracts.js";
import { CSV_EXPORT_MAX_CHUNKS } from "./csv-chunks.js";

const CONTINUATION_DELAY_SECONDS = 5;
const BUSY_RETRY_DELAY_SECONDS = 15;
const ERROR_RETRY_DELAY_SECONDS = 30;
const LEASE_SECONDS = 60;

export interface DataExportConsumerEnv<Kind extends DataExportKind> {
  DB: QueryableDatabase;
  EVIDENCE_BUCKET: R2Bucket;
  PRODUCT_AUDIT_EXPORT_QUEUE: Pick<Queue<DataExportQueueMessage<Kind>>, "send">;
}

type FailExportJob = (
  db: QueryableDatabase,
  jobId: string,
  error: unknown,
  failedAt: Date,
  cursor: DataExportCursor,
) => Promise<boolean>;

interface ExportJobRepository<Job extends DataExportJob> {
  get: (db: QueryableDatabase, jobId: string) => Promise<Job | null>;
  claim: (
    db: QueryableDatabase,
    jobId: string,
    afterId: number,
    chunkCount: number,
    claimedAt: Date,
    leaseSeconds: number,
  ) => Promise<ClaimedDataExportJob<Job> | null>;
  advance: (db: QueryableDatabase, input: AdvanceDataExportJobInput) => Promise<boolean>;
  release: (
    db: QueryableDatabase,
    jobId: string,
    leaseToken: string,
    releasedAt: Date,
    error: unknown,
  ) => Promise<boolean>;
  leaseExpiry: (
    db: QueryableDatabase,
    jobId: string,
    cursor: DataExportCursor,
  ) => Promise<string | null>;
  fail: FailExportJob;
  failQueued: FailExportJob;
  failClaimed: (
    db: QueryableDatabase,
    jobId: string,
    leaseToken: string,
    error: unknown,
    failedAt: Date,
    cursor: DataExportCursor,
  ) => Promise<boolean>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shared delivery state machine; repositories retain their own SQL, scopes and horizons. */
export function createExportConsumer<Job extends DataExportJob, Kind extends DataExportKind>({
  kind,
  repository,
  ensureChunk,
}: {
  kind: Kind;
  repository: ExportJobRepository<Job>;
  ensureChunk: (
    env: DataExportConsumerEnv<Kind>,
    job: Job,
    message: DataExportQueueMessage<Kind>,
  ) => Promise<StoredDataExportChunk>;
}) {
  function retryUnclaimableMessage(
    message: Message<DataExportQueueMessage<Kind>>,
    job: Job,
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
    message.retry({ delaySeconds: BUSY_RETRY_DELAY_SECONDS });
    return "retried";
  }

  async function consumeMessage(
    env: DataExportConsumerEnv<Kind>,
    message: Message<DataExportQueueMessage<Kind>>,
  ): Promise<{ status: "completed" | "continued" | "failed" | "ignored" | "retrying" }> {
    if (!isDataExportQueueMessage(message.body, kind)) {
      console.error(
        JSON.stringify({ event: `${kind}_invalid_message`, body: message.body }),
      );
      message.ack();
      return { status: "ignored" };
    }

    const body = message.body;
    let claim: ClaimedDataExportJob<Job> | null = null;
    try {
      const claimedAt = new Date();
      claim = await repository.claim(
        env.DB,
        body.jobId,
        body.expectedAfterId,
        body.expectedChunkCount,
        claimedAt,
        LEASE_SECONDS,
      );
      if (!claim) {
        const current = await repository.get(env.DB, body.jobId);
        if (!current) {
          message.ack();
          return { status: "ignored" };
        }
        const observedAt = new Date();
        if (
          (current.status === "queued" || current.status === "processing") &&
          current.expiresAt !== null &&
          current.expiresAt <= observedAt.toISOString()
        ) {
          await repository.fail(
            env.DB,
            current.id,
            `${kind}_generation_deadline_exceeded`,
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
      if (
        claim.job.format !== "complete" &&
        chunk.hasMore &&
        body.expectedChunkCount + 1 >= CSV_EXPORT_MAX_CHUNKS
      ) {
        const failed = await repository.failClaimed(
          env.DB,
          claim.job.id,
          claim.leaseToken,
          `${kind}_too_large`,
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
            event: `${kind}_size_limit_exceeded`,
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
            kind,
            jobId: claim.job.id,
            expectedAfterId: chunk.nextAfterId,
            expectedChunkCount: body.expectedChunkCount + 1,
          },
          { delaySeconds: CONTINUATION_DELAY_SECONDS },
        );
      }

      const advanced = await repository.advance(env.DB, {
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
            ? `${kind}_chunk_completed`
            : `${kind}_ready`,
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
          await repository.release(
            env.DB,
            claim.job.id,
            claim.leaseToken,
            new Date(),
            `delivery_error:${errorMessage(error)}`,
          );
        } catch (releaseError) {
          console.error(
            JSON.stringify({
              event: `${kind}_claim_release_failed`,
              jobId: claim.job.id,
              error: errorMessage(releaseError),
            }),
          );
        }
      }
      message.retry({ delaySeconds: ERROR_RETRY_DELAY_SECONDS });
      console.error(
        JSON.stringify({
          event: `${kind}_delivery_retry`,
          jobId: body.jobId,
          chunkIndex: body.expectedChunkCount,
          error: errorMessage(error),
        }),
      );
      return { status: "retrying" };
    }
  }

  /** Processes messages sequentially so one delivery can consume at most one bounded CPU slice. */
  async function consumeBatch(
    env: DataExportConsumerEnv<Kind>,
    batch: MessageBatch<DataExportQueueMessage<Kind>>,
  ): Promise<void> {
    for (const message of batch.messages) {
      await consumeMessage(env, message);
    }
  }

  /** Marks delivery-exhausted jobs failed and acknowledges each DLQ message independently. */
  async function consumeDeadLetterBatch(
    env: DataExportConsumerEnv<Kind>,
    batch: MessageBatch<DataExportQueueMessage<Kind>>,
  ): Promise<void> {
    for (const message of batch.messages) {
      if (!isDataExportQueueMessage(message.body, kind)) {
        message.ack();
        continue;
      }
      try {
        const current = await repository.get(env.DB, message.body.jobId);
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
          const leaseExpiresAt = await repository.leaseExpiry(env.DB, current.id, {
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
          // A live claimant may still commit this cursor. If it crashed, this delayed main-queue
          // delivery takes over after the lease; if it succeeds, the delivery is stale and acked.
          await env.PRODUCT_AUDIT_EXPORT_QUEUE.send(message.body, { delaySeconds });
          console.warn(
            JSON.stringify({
              event: `${kind}_dead_letter_requeued`,
              jobId: current.id,
              chunkIndex: message.body.expectedChunkCount,
              delaySeconds,
            }),
          );
          message.ack();
          continue;
        }
        const failed = await repository.failQueued(
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
          message.retry({ delaySeconds: BUSY_RETRY_DELAY_SECONDS });
          continue;
        }
        console.error(
          JSON.stringify({
            event: `${kind}_dead_letter`,
            jobId: message.body.jobId,
            chunkIndex: message.body.expectedChunkCount,
          }),
        );
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: `${kind}_dead_letter_retry`,
            jobId: message.body.jobId,
            error: errorMessage(error),
          }),
        );
        message.retry({ delaySeconds: ERROR_RETRY_DELAY_SECONDS });
      }
    }
  }

  return { consumeMessage, consumeBatch, consumeDeadLetterBatch };
}
