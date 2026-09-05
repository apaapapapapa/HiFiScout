import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  claimProductAuditExportJob,
  failQueuedProductAuditExportJob,
  getProductAuditExportJob,
} from "../src/db/product-audit-export-job-repository.js";
import {
  consumeProductAuditExportDeadLetterBatch,
  consumeProductAuditExportMessage,
} from "../src/product-audit-export/consumer.js";
import {
  createProductAuditExportDownloadResponse,
  recoverStaleProductAuditExportJobs,
  startProductAuditExport,
} from "../src/product-audit-export/service.js";
import { PRODUCT_AUDIT_EXPORT_MAX_CHUNKS } from "../src/product-audit-export/csv.js";
import type { ProductAuditExportQueueMessage } from "../src/product-audit-export/types.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

/** Exercise pre-upgrade jobs separately from complete archive coverage. */
const startLegacyExport = (
  db: Parameters<typeof startProductAuditExport>[0],
  queue: Parameters<typeof startProductAuditExport>[1],
  scope: Parameters<typeof startProductAuditExport>[2],
  now: Parameters<typeof startProductAuditExport>[3] = new Date(),
) => startProductAuditExport(db, queue, scope, now, "csv");

const RECENT_NOW = new Date(Date.now() - 60_000);

interface StoredObject {
  bytes: Uint8Array<ArrayBuffer>;
  customMetadata: Record<string, string>;
}

interface SentMessage {
  body: ProductAuditExportQueueMessage;
  options?: QueueSendOptions;
}

function productInsert(sqlite: ReturnType<typeof migratedSqlite>["sqlite"]) {
  return sqlite.prepare(`
    INSERT INTO products(
      shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at,
      is_active
    ) VALUES ('test-shop', ?, ?, ?, ?, ?, ?, ?)
  `);
}

function insertProducts(
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  count: number,
  { active = 1, offset = 0 }: { active?: 0 | 1; offset?: number } = {},
): number[] {
  const insert = productInsert(sqlite);
  const ids: number[] = [];
  for (let index = 1; index <= count; index += 1) {
    const value = index + offset;
    ids.push(
      Number(
        insert.run(
          `source-${value}`,
          `Product ${value}`,
          `https://example.test/${value}`,
          "2026-08-22T00:00:00.000Z",
          "2026-08-22T00:00:00.000Z",
          "2026-08-22T00:00:00.000Z",
          active,
        ).lastInsertRowid,
      ),
    );
  }
  return ids;
}

function fakeQueue() {
  const sent: SentMessage[] = [];
  return {
    sent,
    queue: {
      async send(
        body: ProductAuditExportQueueMessage,
        options?: QueueSendOptions,
      ): Promise<QueueSendResponse> {
        sent.push({ body, options });
        return {
          metadata: {
            metrics: { backlogCount: sent.length, backlogBytes: 0 },
          },
        };
      },
    },
  };
}

function r2Object(
  key: string,
  stored: StoredObject,
  { body = false }: { body?: boolean } = {},
): R2Object | R2ObjectBody {
  const metadata = {
    key,
    version: "test-version",
    size: stored.bytes.byteLength,
    etag: "test-etag",
    httpEtag: '"test-etag"',
    checksums: { toJSON: () => ({}) },
    uploaded: new Date("2026-08-22T00:00:00.000Z"),
    customMetadata: { ...stored.customMetadata },
    storageClass: "Standard",
    writeHttpMetadata() {},
  };
  if (!body) return metadata as R2Object;

  const bytes = new Uint8Array(stored.bytes);
  const copyBytes = () => new Uint8Array(bytes);
  return {
    ...metadata,
    bodyUsed: false,
    body: new ReadableStream<Uint8Array>({
      type: "bytes",
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    async arrayBuffer() {
      return copyBytes().buffer;
    },
    async bytes() {
      return copyBytes();
    },
    async text() {
      return new TextDecoder().decode(bytes);
    },
    async json<T>() {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    },
    async blob() {
      return new Blob([copyBytes()]);
    },
  } as R2ObjectBody;
}

function fakeBucket() {
  const objects = new Map<string, StoredObject>();
  const bucket = {
    async head(key: string): Promise<R2Object | null> {
      const stored = objects.get(key);
      return stored ? r2Object(key, stored) : null;
    },
    async get(key: string): Promise<R2ObjectBody | null> {
      const stored = objects.get(key);
      return stored ? (r2Object(key, stored, { body: true }) as R2ObjectBody) : null;
    },
    async put(
      key: string,
      value: ArrayBuffer | ArrayBufferView | string | Blob | ReadableStream | null,
      options?: R2PutOptions,
    ): Promise<R2Object | null> {
      if (objects.has(key) && options?.onlyIf) return null;
      if (!(value instanceof Uint8Array)) throw new Error("test_bucket_requires_bytes");
      const stored: StoredObject = {
        bytes: new Uint8Array(value),
        customMetadata: { ...options?.customMetadata },
      };
      objects.set(key, stored);
      return r2Object(key, stored);
    },
  } as Pick<R2Bucket, "get" | "head" | "put">;
  return { bucket: bucket as R2Bucket, objects };
}

function fakeMessage(body: ProductAuditExportQueueMessage) {
  let acknowledgements = 0;
  const retries: QueueRetryOptions[] = [];
  const message = {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts: 1,
    ack() {
      acknowledgements += 1;
    },
    retry(options: QueueRetryOptions = {}) {
      retries.push(options);
    },
  } satisfies Message<ProductAuditExportQueueMessage>;
  return {
    message,
    acknowledgements: () => acknowledgements,
    retries,
  };
}

test("starting an export reuses the in-flight scope and never creates parallel jobs", async () => {
  const { sqlite, db } = migratedSqlite();
  insertProducts(sqlite, 1);
  const { queue, sent } = fakeQueue();
  const now = new Date("2026-08-22T00:00:00.000Z");

  const first = await startLegacyExport(db, queue, "active", now);
  const second = await startLegacyExport(db, queue, "active", now);

  assert.equal(first.id, second.id);
  assert.equal(first.maxListingId, 1);
  assert.equal(
    Date.parse(first.expiresAt || "") - Date.parse(first.createdAt),
    24 * 60 * 60 * 1000,
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM product_audit_export_jobs").get()?.count,
    1,
  );
  assert.equal(sent.length, 1, "a repeated request must not flood the healthy cursor");
  assert.deepEqual(sent[0]?.body, {
    kind: "product_audit_export",
    jobId: first.id,
    expectedAfterId: 0,
    expectedChunkCount: 0,
  });
});

test("a stale cursor is re-enqueued once and an overdue scope can start a replacement", async () => {
  const { sqlite, db } = migratedSqlite();
  insertProducts(sqlite, 1);
  const { queue, sent } = fakeQueue();
  const createdAt = new Date("2026-08-22T00:00:00.000Z");
  const first = await startLegacyExport(db, queue, "active", createdAt);
  sent.length = 0;

  const recoveredAt = new Date(createdAt.getTime() + 3 * 60 * 1000);
  assert.equal(await recoverStaleProductAuditExportJobs(db, queue, recoveredAt), 1);
  assert.equal(sent.length, 1);
  assert.equal(await recoverStaleProductAuditExportJobs(db, queue, recoveredAt), 0);
  assert.equal(sent.length, 1, "the enqueue reservation throttles repeated recovery passes");

  const replacementAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000 + 1);
  const replacement = await startLegacyExport(db, queue, "active", replacementAt);
  assert.notEqual(replacement.id, first.id);
  assert.equal((await getProductAuditExportJob(db, first.id))?.status, "failed");
  assert.equal((await getProductAuditExportJob(db, replacement.id))?.status, "queued");
});

test("one delivery writes only 250 rows, retries are idempotent, and ready CSV streams chunks", async () => {
  const { sqlite, db } = migratedSqlite();
  const ids = insertProducts(sqlite, 251);
  const { queue, sent } = fakeQueue();
  const { bucket, objects } = fakeBucket();
  const now = new Date(RECENT_NOW);
  const job = await startLegacyExport(db, queue, "active", now);
  assert.equal(job.maxListingId, ids.at(-1));

  // The job has a finite ID horizon even when listings arrive while its batches are running.
  insertProducts(sqlite, 1, { offset: 10_000 });

  const firstBody = sent.shift()?.body;
  assert.ok(firstBody);
  const firstDelivery = fakeMessage(firstBody);
  const firstResult = await consumeProductAuditExportMessage(
    { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
    firstDelivery.message,
  );
  assert.equal(firstResult.status, "continued");
  assert.equal(firstDelivery.acknowledgements(), 1);
  assert.deepEqual(firstDelivery.retries, []);

  const afterFirst = await getProductAuditExportJob(db, job.id);
  assert.equal(afterFirst?.status, "queued");
  assert.equal(afterFirst?.rowCount, 250);
  assert.equal(afterFirst?.chunkCount, 1);
  assert.equal(afterFirst?.afterId, ids[249]);
  assert.equal(objects.size, 1);
  assert.equal(sent[0]?.options?.delaySeconds, 5);

  // The ID horizon is finite, but fields are intentionally read page-by-page rather than from a
  // long-running transaction snapshot.
  sqlite
    .prepare("UPDATE products SET source_id = ? WHERE id = ?")
    .run("source-251-mutated", ids[250]);

  const duplicate = fakeMessage(firstBody);
  const duplicateResult = await consumeProductAuditExportMessage(
    { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
    duplicate.message,
  );
  assert.equal(duplicateResult.status, "ignored");
  assert.equal(duplicate.acknowledgements(), 1);
  assert.equal(objects.size, 1);
  assert.equal(sent.length, 1, "a stale delivery must not fork the continuation chain");

  const continuationBody = sent.shift()?.body;
  assert.ok(continuationBody);
  const continuation = fakeMessage(continuationBody);
  const finalResult = await consumeProductAuditExportMessage(
    { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
    continuation.message,
  );
  assert.equal(finalResult.status, "completed");
  assert.equal(continuation.acknowledgements(), 1);
  assert.equal(sent.length, 0);

  const ready = await getProductAuditExportJob(db, job.id);
  assert.equal(ready?.status, "ready");
  assert.equal(ready?.rowCount, 251);
  assert.equal(ready?.chunkCount, 2);
  assert.ok(ready?.completedAt);
  assert.ok(ready.expiresAt);
  assert.equal(
    Date.parse(ready.expiresAt) - Date.parse(ready.completedAt),
    7 * 24 * 60 * 60 * 1000,
  );

  const response = await createProductAuditExportDownloadResponse(db, bucket, job.id, now);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(ready?.byteCount));
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xef, 0xbb, 0xbf]);
  const csv = new TextDecoder().decode(bytes);
  assert.equal(csv.match(/listing_id,shop_key/gu)?.length, 1, "header belongs to chunk zero only");
  assert.match(csv, /"source-1"/u);
  assert.match(csv, /"source-251-mutated"/u);
  assert.doesNotMatch(
    csv,
    /"source-10001"/u,
    "rows inserted after start are beyond the ID horizon",
  );

  const expired = await createProductAuditExportDownloadResponse(
    db,
    bucket,
    job.id,
    new Date(ready.expiresAt),
  );
  assert.equal(expired.status, 410);
});

test("a future DLQ delivery cannot fail a job whose predecessor owns the current cursor", async () => {
  const { db } = migratedSqlite();
  const { queue } = fakeQueue();
  const { bucket } = fakeBucket();
  const job = await startLegacyExport(db, queue, "active", new Date("2026-08-22T00:00:00.000Z"));
  const future = fakeMessage({
    kind: "product_audit_export",
    jobId: job.id,
    expectedAfterId: 100,
    expectedChunkCount: 1,
  });
  const batch = {
    queue: "hifiscout-product-audit-export-dlq",
    messages: [future.message],
    ackAll() {},
    retryAll() {},
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  } satisfies MessageBatch<ProductAuditExportQueueMessage>;

  await consumeProductAuditExportDeadLetterBatch(
    { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
    batch,
  );

  assert.equal(future.acknowledgements(), 1);
  assert.equal((await getProductAuditExportJob(db, job.id))?.status, "queued");
});

test("a delivery in the DLQ cannot fail a cursor that still has a live lease", async () => {
  const { db } = migratedSqlite();
  const { queue, sent } = fakeQueue();
  const { bucket } = fakeBucket();
  const job = await startLegacyExport(db, queue, "active", new Date(RECENT_NOW));
  const original = sent[0]?.body;
  assert.ok(original);
  const claimedAt = new Date();
  assert.ok(await claimProductAuditExportJob(db, job.id, 0, 0, claimedAt, 60));

  const redelivery = fakeMessage(original);
  const busyResult = await consumeProductAuditExportMessage(
    { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
    redelivery.message,
  );
  assert.equal(busyResult.status, "retrying");
  assert.deepEqual(redelivery.retries, [{ delaySeconds: 15 }]);

  const deadLetter = fakeMessage(original);
  const batch = {
    queue: "hifiscout-product-audit-export-dlq",
    messages: [deadLetter.message],
    ackAll() {},
    retryAll() {},
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  } satisfies MessageBatch<ProductAuditExportQueueMessage>;
  await consumeProductAuditExportDeadLetterBatch(
    { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
    batch,
  );

  assert.equal(deadLetter.acknowledgements(), 1);
  assert.equal(deadLetter.retries.length, 0);
  assert.equal(sent.length, 2, "the DLQ delivery is returned to the main queue after the lease");
  assert.deepEqual(sent[1]?.body, original);
  assert.ok((sent[1]?.options?.delaySeconds || 0) > 0);
  assert.equal((await getProductAuditExportJob(db, job.id))?.status, "processing");
});

test("the DLQ queued-only failure CAS loses safely to a concurrent claim", async () => {
  const { db } = migratedSqlite();
  const { queue } = fakeQueue();
  const job = await startLegacyExport(db, queue, "active", new Date());
  const claimedAt = new Date();
  assert.ok(await claimProductAuditExportJob(db, job.id, 0, 0, claimedAt, 60));

  const failed = await failQueuedProductAuditExportJob(
    db,
    job.id,
    "queue_delivery_exhausted",
    new Date(),
    { afterId: 0, chunkCount: 0 },
  );
  assert.equal(failed, false);
  assert.equal((await getProductAuditExportJob(db, job.id))?.status, "processing");
});

test("generation fails clearly before exceeding the bounded download chunk count", async () => {
  const { sqlite, db } = migratedSqlite();
  insertProducts(sqlite, 251);
  const { queue, sent } = fakeQueue();
  const { bucket } = fakeBucket();
  const job = await startLegacyExport(db, queue, "all", new Date());
  sqlite
    .prepare("UPDATE product_audit_export_jobs SET chunk_count = ? WHERE id = ?")
    .run(PRODUCT_AUDIT_EXPORT_MAX_CHUNKS - 1, job.id);
  const body: ProductAuditExportQueueMessage = {
    kind: "product_audit_export",
    jobId: job.id,
    expectedAfterId: 0,
    expectedChunkCount: PRODUCT_AUDIT_EXPORT_MAX_CHUNKS - 1,
  };
  sent.length = 0;
  const delivery = fakeMessage(body);
  const result = await consumeProductAuditExportMessage(
    { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
    delivery.message,
  );

  assert.equal(result.status, "failed");
  assert.equal(delivery.acknowledgements(), 1);
  assert.equal(sent.length, 0);
  const failed = await getProductAuditExportJob(db, job.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "product_audit_export_too_large");

  sqlite
    .prepare(`
      UPDATE product_audit_export_jobs
      SET status = 'ready', chunk_count = ?, completed_at = ?, expires_at = ?
      WHERE id = ?
    `)
    .run(
      PRODUCT_AUDIT_EXPORT_MAX_CHUNKS + 1,
      "2026-08-22T00:00:00.000Z",
      "2099-08-29T00:00:00.000Z",
      job.id,
    );
  const defensiveDownload = await createProductAuditExportDownloadResponse(db, bucket, job.id);
  assert.equal(defensiveDownload.status, 503);
  assert.deepEqual(await defensiveDownload.json(), {
    error: "product_audit_export_too_many_chunks",
  });
});
