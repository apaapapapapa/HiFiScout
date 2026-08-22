import assert from "node:assert/strict";
import test from "node:test";

import {
  knowledgeCatalogCsvHeader,
  knowledgeCatalogCsvRow,
} from "../src/admin/knowledge-catalog-csv.js";
import {
  KNOWLEDGE_CATALOG_EXPORT_IDENTITY_COUNT_LIMIT,
  listKnowledgeCatalogExportPage,
} from "../src/db/knowledge-catalog-export-repository.js";
import {
  advanceKnowledgeCatalogExportJob,
  claimKnowledgeCatalogExportJob,
  failQueuedKnowledgeCatalogExportJob,
  getKnowledgeCatalogExportJob,
} from "../src/db/knowledge-catalog-export-job-repository.js";
import {
  consumeKnowledgeCatalogExportDeadLetterBatch,
  consumeKnowledgeCatalogExportMessage,
} from "../src/knowledge-catalog-export/consumer.js";
import { KNOWLEDGE_CATALOG_EXPORT_MAX_CHUNKS } from "../src/knowledge-catalog-export/csv.js";
import {
  createKnowledgeCatalogExportDownloadResponse,
  recoverStaleKnowledgeCatalogExportJobs,
  startKnowledgeCatalogExport,
} from "../src/knowledge-catalog-export/service.js";
import type { KnowledgeCatalogExportQueueMessage } from "../src/knowledge-catalog-export/types.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import {
  queryPlan,
  readsThroughIndex,
  recordingDatabase,
  unindexedScans,
} from "./helpers/query-plan.js";

const NOW = "2026-08-22T00:00:00.000Z";

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === ",") {
      fields.push(field);
      field = "";
    } else if (character === '"') {
      quoted = true;
    } else {
      field += character;
    }
  }
  assert.equal(quoted, false, "CSV line must close every quoted cell");
  fields.push(field);
  return fields;
}

interface StoredObject {
  bytes: Uint8Array<ArrayBuffer>;
  customMetadata: Record<string, string>;
}

interface SentMessage {
  body: KnowledgeCatalogExportQueueMessage;
  options?: QueueSendOptions;
}

function clearCatalogFixtureData(sqlite: ReturnType<typeof migratedSqlite>["sqlite"]): void {
  sqlite.exec(`
    DELETE FROM product_search_entity_offers;
    DELETE FROM product_search_entities;
    DELETE FROM product_identity_resolutions;
    DELETE FROM knowledge_catalog_verification_attempts;
    DELETE FROM knowledge_catalog_candidates;
    DELETE FROM knowledge_catalog_products;
    DELETE FROM knowledge_catalog_manufacturers;
  `);
}

function insertCatalogProducts(
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  count: number,
  offset = 0,
): number[] {
  const insert = sqlite.prepare(`
    INSERT INTO knowledge_catalog_products (
      manufacturer_id, canonical_model, normalized_model, canonical_name,
      lifecycle_status, verification_status, review_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ids: number[] = [];
  for (let index = 1; index <= count; index += 1) {
    const value = index + offset;
    ids.push(
      Number(
        insert.run(
          value === 1 ? "acme" : `maker-${value}`,
          `Model ${value}`,
          `model-${value}`,
          value === 1 ? "=Formula-looking name" : `Product ${value}`,
          value % 2 ? "active" : "discontinued",
          value % 2 ? "verified" : "rejected",
          value % 2 ? "current" : "due",
          NOW,
          NOW,
        ).lastInsertRowid,
      ),
    );
  }
  return ids;
}

function insertListing(
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  sourceId: string,
  active: 0 | 1,
): number {
  return Number(
    sqlite
      .prepare(`
        INSERT INTO products (
          shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at,
          is_active
        ) VALUES ('test-shop', ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(sourceId, sourceId, `https://example.test/${sourceId}`, NOW, NOW, NOW, active)
      .lastInsertRowid,
  );
}

function insertMatchedIdentities(
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  catalogProductId: number,
  count: number,
  active: 0 | 1,
): void {
  const identity = sqlite.prepare(`
    INSERT INTO product_identity_resolutions (
      listing_product_id, catalog_product_id, candidate_catalog_product_id, status,
      match_method, confidence, normalized_model, model_stem, variants_json,
      matched_fields_json, rejected_by_json, evaluated_at
    ) VALUES (?, ?, NULL, 'matched', 'exact', 'high', 'model-1', 'model1', '[]', '[]', '[]', ?)
  `);
  for (let index = 0; index < count; index += 1) {
    const listingId = insertListing(sqlite, `extra-listing-${active}-${index}`, active);
    identity.run(listingId, catalogProductId, NOW);
  }
}

function arrangeRichEvidence(
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  catalogProductId: number,
): void {
  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_manufacturers (
        id, canonical_name, verification_status, source, provenance_json, created_at, updated_at
      ) VALUES ('acme', 'Acme Audio', 'verified', 'manual', '{"source":"fixture"}', ?, ?)
    `)
    .run(NOW, NOW);

  const category = sqlite.prepare(`
    INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
    VALUES (?, ?, ?)
  `);
  for (let index = 0; index < 21; index += 1) {
    category.run(
      catalogProductId,
      `category-${String(index).padStart(2, "0")}`,
      index === 0 ? 1 : 0,
    );
  }

  const alias = sqlite.prepare(`
    INSERT INTO knowledge_catalog_aliases(
      product_id, alias, normalized_alias, alias_type, created_at
    ) VALUES (?, ?, ?, 'model', ?)
  `);
  for (let index = 0; index < 51; index += 1) {
    alias.run(catalogProductId, `Alias ${index}`, `alias-${index}`, NOW);
  }

  const source = sqlite.prepare(`
    INSERT INTO knowledge_catalog_sources(
      product_id, source_type, source_url, retrieved_at, content_hash, status, created_at, updated_at
    ) VALUES (?, 'trusted_catalog', ?, ?, ?, 'active', ?, ?)
  `);
  for (let index = 0; index < 21; index += 1) {
    source.run(catalogProductId, `https://evidence.test/${index}`, NOW, `hash-${index}`, NOW, NOW);
  }

  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_candidates (
        manufacturer_id, normalized_model, observed_manufacturer, observed_model, sample_title,
        candidate_category_ids, active_listing_count, shop_count, unclassified_count,
        priority_score, review_status, catalog_product_id, first_seen_at, last_seen_at,
        last_reviewed_at, created_at, updated_at, verification_status, last_verification_at,
        verification_message, source_url, other_count, unresolved_identity_count,
        raw_model_variants, evidence_source_urls, identity_rejection_reason
      ) VALUES (
        'acme', 'model-1', 'ACME', 'M-1', 'Seller title', '["speaker"]', 7, 3, 2,
        19, 'matched', ?, ?, ?, ?, ?, ?, 'verified', ?, 'candidate verified',
        'https://candidate.test/1', 1, 4, '["M-1","M1"]',
        '["https://seller.test/1"]', 'variant_conflict'
      )
    `)
    .run(catalogProductId, NOW, NOW, NOW, NOW, NOW, NOW);

  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_verification_attempts (
        candidate_id, product_id, manufacturer_id, normalized_model, source_type, source_url,
        attempted_at, status, http_status, content_hash, message
      ) VALUES (
        (SELECT id FROM knowledge_catalog_candidates WHERE manufacturer_id = 'acme'), ?,
        'acme', 'model-1', 'manufacturer_official', 'https://official.test/m1', ?,
        'verified', 200, 'official-hash', 'latest attempt'
      )
    `)
    .run(catalogProductId, NOW);

  const activeListingId = insertListing(sqlite, "active-listing", 1);
  const inactiveListingId = insertListing(sqlite, "inactive-listing", 0);
  const identity = sqlite.prepare(`
    INSERT INTO product_identity_resolutions (
      listing_product_id, catalog_product_id, candidate_catalog_product_id, status,
      match_method, confidence, normalized_model, model_stem, variants_json,
      matched_fields_json, rejected_by_json, evaluated_at
    ) VALUES (?, ?, NULL, 'matched', 'exact', 'high', 'model-1', 'model1', '[]', '[]', '[]', ?)
  `);
  identity.run(activeListingId, catalogProductId, NOW);
  identity.run(inactiveListingId, catalogProductId, NOW);

  sqlite
    .prepare(`
      INSERT INTO product_search_entities (
        entity_key, entity_kind, catalog_product_id, manufacturer_id, manufacturer, model,
        normalized_model, primary_category_id, offer_count, in_stock_offer_count,
        sold_out_offer_count, shop_count, lowest_price_yen, lowest_in_stock_price_yen,
        highest_price_yen, latest_activity_at, newest_listed_at, has_price_drop
      ) VALUES (
        ?, 'catalog', ?, 'acme', 'Acme Audio', 'Model 1', 'model-1', 'category-00',
        2, 1, 1, 2, 100000, 110000, 120000, ?, ?, 1
      )
    `)
    .run(`c-${catalogProductId}`, catalogProductId, NOW, NOW);
}

function fakeQueue() {
  const sent: SentMessage[] = [];
  return {
    sent,
    queue: {
      async send(
        body: KnowledgeCatalogExportQueueMessage,
        options?: QueueSendOptions,
      ): Promise<QueueSendResponse> {
        sent.push({ body, options });
        return { metadata: { metrics: { backlogCount: sent.length, backlogBytes: 0 } } };
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
    uploaded: new Date(NOW),
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
  const putKeys: string[] = [];
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
      putKeys.push(key);
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
  return { bucket: bucket as R2Bucket, objects, putKeys };
}

function fakeMessage(body: KnowledgeCatalogExportQueueMessage) {
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
  } satisfies Message<KnowledgeCatalogExportQueueMessage>;
  return { message, acknowledgements: () => acknowledgements, retries };
}

test("catalog export query is horizon bounded, includes every status, and bounds child JSON", async () => {
  const { sqlite, db } = migratedSqlite();
  clearCatalogFixtureData(sqlite);
  const ids = insertCatalogProducts(sqlite, 101);
  arrangeRichEvidence(sqlite, ids[0]);
  sqlite
    .prepare(
      "UPDATE knowledge_catalog_candidates SET raw_model_variants = ? WHERE catalog_product_id = ?",
    )
    .run(`["raw-evidence"]\u0000${"x".repeat(1_000_000)}`, ids[0]);
  const oversizedTimestamp = `2\u0000${"3".repeat(1_000_000)}`;
  sqlite
    .prepare("UPDATE knowledge_catalog_products SET created_at = ?, updated_at = ? WHERE id = ?")
    .run(oversizedTimestamp, oversizedTimestamp, ids[0]);
  sqlite
    .prepare(`
      UPDATE knowledge_catalog_aliases SET created_at = ?
      WHERE id = (SELECT MIN(id) FROM knowledge_catalog_aliases WHERE product_id = ?)
    `)
    .run(oversizedTimestamp, ids[0]);
  sqlite
    .prepare(`
      UPDATE knowledge_catalog_sources SET retrieved_at = ?
      WHERE id = (SELECT MIN(id) FROM knowledge_catalog_sources WHERE product_id = ?)
    `)
    .run(oversizedTimestamp, ids[0]);
  insertMatchedIdentities(sqlite, ids[0], KNOWLEDGE_CATALOG_EXPORT_IDENTITY_COUNT_LIMIT + 1, 0);
  const horizon = ids.at(-1) || 0;
  insertCatalogProducts(sqlite, 1, 10_000);

  const recording = recordingDatabase(db);
  const first = await listKnowledgeCatalogExportPage(recording.db, {
    afterId: 0,
    maxId: horizon,
    limit: 100,
  });
  assert.equal(first.items.length, 100);
  assert.equal(first.nextAfterId, ids[99]);
  assert.equal(first.items[1]?.verificationStatus, "rejected", "all statuses are exported");

  const rich = first.items[0];
  assert.ok(rich);
  assert.equal(rich.primaryCategoryId, "category-00");
  assert.equal(rich.categoryCount, 21);
  assert.equal(JSON.parse(rich.categoriesJson).length, 20);
  assert.equal(rich.categoriesTruncated, 1);
  assert.equal(rich.aliasCount, 51);
  assert.equal(JSON.parse(rich.aliasesJson).length, 50);
  assert.equal(rich.aliasesTruncated, 1);
  assert.equal(rich.sourceCount, 21);
  assert.equal(JSON.parse(rich.sourcesJson).length, 20);
  assert.equal(rich.sourcesTruncated, 1);
  assert.equal(rich.manufacturerCanonicalName, "Acme Audio");
  assert.equal(rich.candidateUnresolvedIdentityCount, 4);
  const boundedRawModels = JSON.parse(rich.candidateRawModelVariantsJson);
  assert.equal(boundedRawModels._truncated, 1);
  assert.ok(boundedRawModels.originalBytes > 1_000_000);
  assert.match(rich.createdAt, / \[truncated\]$/u);
  assert.ok(rich.createdAt.length < 256);
  assert.equal(rich.createdAt.includes("\u0000"), false);
  assert.match(JSON.parse(rich.aliasesJson)[0].createdAt, / \[truncated\]$/u);
  assert.match(JSON.parse(rich.sourcesJson)[0].retrievedAt, / \[truncated\]$/u);
  assert.equal(rich.latestVerificationMessage, "latest attempt");
  assert.equal(rich.identitySampleCount, KNOWLEDGE_CATALOG_EXPORT_IDENTITY_COUNT_LIMIT + 1);
  assert.equal(rich.matchedIdentityCount, KNOWLEDGE_CATALOG_EXPORT_IDENTITY_COUNT_LIMIT + 1);
  assert.equal(rich.activeMatchedIdentityCount, 1);
  assert.equal(rich.identitySampleTruncated, 1);
  assert.equal(rich.searchEntityOfferCount, 2);
  const boundedCsvRow = knowledgeCatalogCsvRow({
    ...rich,
    manufacturerCanonicalName: "x".repeat(5_000),
    categoriesJson: "[]",
    aliasesJson: "[]",
    sourcesJson: "[]",
    candidateCategoryIdsJson: "[]",
    candidateRawModelVariantsJson: "[]",
    candidateEvidenceSourceUrlsJson: "[]",
  });
  assert.match(boundedCsvRow, / \[truncated\]/u);
  assert.match(boundedCsvRow, /,"manufacturer_canonical_name"$/u);
  assert.ok(boundedCsvRow.length < 10_000, "one oversized cell cannot inflate a CSV row");
  const boundedJsonRow = parseCsvLine(
    knowledgeCatalogCsvRow({
      ...rich,
      categoriesJson: "[]",
      aliasesJson: JSON.stringify(["alias".repeat(10_000)]),
      sourcesJson: "[]",
      candidateCategoryIdsJson: "[]",
      candidateRawModelVariantsJson: "[]",
      candidateEvidenceSourceUrlsJson: "[]",
    }),
  );
  const csvHeaders = knowledgeCatalogCsvHeader().split(",");
  const aliasesIndex = csvHeaders.indexOf("aliases_json");
  assert.ok(aliasesIndex >= 0);
  assert.equal(JSON.parse(boundedJsonRow[aliasesIndex])._truncated, 1);
  assert.match(boundedJsonRow.at(-1) || "", /aliases_json/u);

  const final = await listKnowledgeCatalogExportPage(db, {
    afterId: first.nextAfterId || 0,
    maxId: horizon,
    limit: 100,
  });
  assert.deepEqual(
    final.items.map((row) => row.catalogProductId),
    [ids[100]],
  );
  assert.equal(final.nextAfterId, null);
  assert.deepEqual(await listKnowledgeCatalogExportPage(db, { afterId: 0, maxId: 0, limit: 100 }), {
    items: [],
    nextAfterId: null,
  });

  const executed = recording.executed[0];
  assert.ok(executed);
  assert.match(
    executed.sql,
    /FROM \(\s*SELECT pir_sample\.listing_product_id, pir_sample\.status[\s\S]*?LIMIT 101\s*\) identity_sample\s*LEFT JOIN products p_identity/u,
    "the identity scan is capped before product activity is evaluated",
  );
  const plan = queryPlan(sqlite, executed);
  assert.ok(
    plan.some((step) =>
      /SEARCH kp USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/u.test(step.detail),
    ),
  );
  assert.equal(readsThroughIndex(plan, "pir_sample", "idx_product_identity_catalog"), true);
  assert.equal(
    readsThroughIndex(plan, "kpc", "idx_knowledge_catalog_export_categories_order"),
    true,
  );
  assert.equal(
    readsThroughIndex(
      plan,
      "kva_pick",
      "idx_knowledge_catalog_verification_attempts_product_latest",
    ),
    true,
  );
  assert.equal(readsThroughIndex(plan, "pse_pick", "idx_product_search_entities_catalog"), true);
  assert.equal(
    plan.some((step) => step.detail.includes("USE TEMP B-TREE")),
    false,
    "bounded lookups must not sort an unbounded child set before LIMIT",
  );
  assert.deepEqual(
    unindexedScans(plan, [
      "identity_sample",
      "category_aggregate",
      "alias_aggregate",
      "source_aggregate",
    ]),
    [],
  );
});

test("singleton job emits one 100-row chunk per delivery and streams a stable CSV", async () => {
  const { sqlite, db } = migratedSqlite();
  clearCatalogFixtureData(sqlite);
  const ids = insertCatalogProducts(sqlite, 101);
  const { queue, sent } = fakeQueue();
  const { bucket, objects } = fakeBucket();
  const createdAt = new Date(NOW);
  const job = await startKnowledgeCatalogExport(db, queue, createdAt);
  const reused = await startKnowledgeCatalogExport(db, queue, createdAt);
  assert.equal(reused.id, job.id);
  assert.equal(sent.length, 1);
  assert.equal(job.maxCatalogProductId, ids.at(-1));
  assert.equal(Date.parse(job.expiresAt) - Date.parse(job.createdAt), 24 * 60 * 60 * 1000);

  insertCatalogProducts(sqlite, 1, 20_000);
  const firstBody = sent.shift()?.body;
  assert.ok(firstBody);
  const firstMessage = fakeMessage(firstBody);
  assert.deepEqual(
    await consumeKnowledgeCatalogExportMessage(
      { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
      firstMessage.message,
    ),
    { status: "continued" },
  );
  assert.equal(firstMessage.acknowledgements(), 1);
  assert.equal(sent[0]?.options?.delaySeconds, 5);
  assert.equal(objects.size, 1);
  assert.match([...objects.keys()][0] || "", /knowledge-catalog-exports\/.+\/00000000\.csv/u);

  const duplicate = fakeMessage(firstBody);
  assert.deepEqual(
    await consumeKnowledgeCatalogExportMessage(
      { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
      duplicate.message,
    ),
    { status: "ignored" },
  );
  assert.equal(duplicate.acknowledgements(), 1);
  assert.equal(objects.size, 1);
  assert.equal(sent.length, 1, "a stale duplicate cannot fork the continuation chain");

  const secondBody = sent.shift()?.body;
  assert.ok(secondBody);
  const secondMessage = fakeMessage(secondBody);
  assert.deepEqual(
    await consumeKnowledgeCatalogExportMessage(
      { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
      secondMessage.message,
    ),
    { status: "completed" },
  );
  const ready = await getKnowledgeCatalogExportJob(db, job.id);
  assert.equal(ready?.status, "ready");
  assert.equal(ready?.rowCount, 101);
  assert.equal(ready?.chunkCount, 2);
  assert.ok(ready?.completedAt);
  assert.equal(
    Date.parse(ready?.expiresAt || "") - Date.parse(ready?.completedAt || ""),
    7 * 24 * 60 * 60 * 1000,
  );

  const response = await createKnowledgeCatalogExportDownloadResponse(
    db,
    bucket,
    job.id,
    createdAt,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(ready?.byteCount));
  assert.match(
    response.headers.get("content-disposition") || "",
    /hifiscout-knowledge-catalog-2026-08-22\.csv/u,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xef, 0xbb, 0xbf]);
  const csv = new TextDecoder().decode(bytes);
  const headers = csv.slice(1).split("\r\n", 1)[0]?.split(",") || [];
  assert.equal(csv.match(/catalog_product_id,manufacturer_id/gu)?.length, 1);
  assert.ok(headers.includes("category_count_capped"));
  assert.ok(headers.includes("identity_sample_count"));
  assert.ok(headers.includes("matched_identity_count_sampled"));
  assert.ok(headers.includes("identity_sample_truncated"));
  assert.ok(headers.includes("csv_fields_truncated"));
  assert.equal(headers.includes("category_count"), false);
  assert.equal(headers.includes("matched_identity_count"), false);
  assert.match(csv, /"'=Formula-looking name"/u);
  assert.equal(csv.split("\r\n").length, 103, "header plus 101 rows and trailing CRLF");
  assert.doesNotMatch(csv, /Product 20001/u, "post-start IDs stay beyond the horizon");

  const expired = await createKnowledgeCatalogExportDownloadResponse(
    db,
    bucket,
    job.id,
    new Date(ready?.expiresAt || ""),
  );
  assert.equal(expired.status, 410);
});

test("a retry reuses the persisted R2 chunk after its continuation send fails", async () => {
  const { sqlite, db } = migratedSqlite();
  clearCatalogFixtureData(sqlite);
  insertCatalogProducts(sqlite, 101);
  const { queue, sent } = fakeQueue();
  const { bucket, objects, putKeys } = fakeBucket();
  const job = await startKnowledgeCatalogExport(db, queue, new Date(NOW));
  const body = sent.shift()?.body;
  assert.ok(body);

  let failedSendCount = 0;
  const failingQueue = {
    async send(
      _body: KnowledgeCatalogExportQueueMessage,
      _options?: QueueSendOptions,
    ): Promise<QueueSendResponse> {
      failedSendCount += 1;
      throw new Error("injected_continuation_send_failure");
    },
  };
  const failedDelivery = fakeMessage(body);
  assert.deepEqual(
    await consumeKnowledgeCatalogExportMessage(
      { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: failingQueue },
      failedDelivery.message,
    ),
    { status: "retrying" },
  );
  assert.equal(failedSendCount, 1);
  assert.deepEqual(failedDelivery.retries, [{ delaySeconds: 30 }]);
  assert.equal(failedDelivery.acknowledgements(), 0);
  assert.equal(objects.size, 1, "the first page is durable before the continuation send");
  assert.equal(putKeys.length, 1);
  const released = await getKnowledgeCatalogExportJob(db, job.id);
  assert.equal(released?.status, "queued");
  assert.equal(released?.chunkCount, 0);
  assert.equal(released?.rowCount, 0);

  const retry = fakeMessage(body);
  assert.deepEqual(
    await consumeKnowledgeCatalogExportMessage(
      { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
      retry.message,
    ),
    { status: "continued" },
  );
  assert.equal(retry.acknowledgements(), 1);
  assert.equal(putKeys.length, 1, "the retry must adopt the existing deterministic chunk");
  assert.equal(objects.size, 1);
  assert.equal(sent.length, 1);
  const advanced = await getKnowledgeCatalogExportJob(db, job.id);
  assert.equal(advanced?.status, "queued");
  assert.equal(advanced?.chunkCount, 1);
  assert.equal(advanced?.rowCount, 100);
});

test("a future continuation arriving before predecessor recovery still aggregates once", async () => {
  const { sqlite, db } = migratedSqlite();
  clearCatalogFixtureData(sqlite);
  insertCatalogProducts(sqlite, 101);
  const { queue, sent } = fakeQueue();
  const { bucket, objects, putKeys } = fakeBucket();
  const job = await startKnowledgeCatalogExport(db, queue, new Date(NOW));
  const predecessorBody = sent.shift()?.body;
  assert.ok(predecessorBody);

  sqlite.exec(`
    CREATE TRIGGER fail_catalog_export_advance_once
    BEFORE UPDATE OF after_id ON knowledge_catalog_export_jobs
    BEGIN
      SELECT RAISE(FAIL, 'injected_catalog_export_advance_failure');
    END;
  `);
  const failedPredecessor = fakeMessage(predecessorBody);
  assert.deepEqual(
    await consumeKnowledgeCatalogExportMessage(
      { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
      failedPredecessor.message,
    ),
    { status: "retrying" },
  );
  sqlite.exec("DROP TRIGGER fail_catalog_export_advance_once");
  assert.deepEqual(failedPredecessor.retries, [{ delaySeconds: 30 }]);
  assert.equal(putKeys.length, 1);
  assert.equal(sent.length, 1, "the future continuation was durable before D1 advance failed");
  const futureBody = sent.shift()?.body;
  assert.ok(futureBody);
  assert.equal(futureBody.expectedChunkCount, 1);

  const earlyFuture = fakeMessage(futureBody);
  assert.deepEqual(
    await consumeKnowledgeCatalogExportMessage(
      { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
      earlyFuture.message,
    ),
    { status: "retrying" },
  );
  assert.deepEqual(earlyFuture.retries, [{ delaySeconds: 15 }]);
  assert.equal(earlyFuture.acknowledgements(), 0);

  const predecessorRetry = fakeMessage(predecessorBody);
  assert.deepEqual(
    await consumeKnowledgeCatalogExportMessage(
      { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
      predecessorRetry.message,
    ),
    { status: "continued" },
  );
  assert.equal(predecessorRetry.acknowledgements(), 1);
  assert.equal(putKeys.length, 1, "predecessor recovery reuses chunk zero");
  assert.equal(sent.length, 1, "predecessor recovery safely duplicates the continuation");

  const futureRetry = fakeMessage(futureBody);
  assert.deepEqual(
    await consumeKnowledgeCatalogExportMessage(
      { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
      futureRetry.message,
    ),
    { status: "completed" },
  );
  const ready = await getKnowledgeCatalogExportJob(db, job.id);
  assert.equal(ready?.status, "ready");
  assert.equal(ready?.chunkCount, 2);
  assert.equal(ready?.rowCount, 101);
  assert.equal(objects.size, 2);
  assert.equal(
    ready?.byteCount,
    [...objects.values()].reduce((total, object) => total + object.bytes.byteLength, 0),
  );

  const duplicateFutureBody = sent.shift()?.body;
  assert.ok(duplicateFutureBody);
  const duplicateFuture = fakeMessage(duplicateFutureBody);
  assert.deepEqual(
    await consumeKnowledgeCatalogExportMessage(
      { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
      duplicateFuture.message,
    ),
    { status: "ignored" },
  );
  assert.equal(duplicateFuture.acknowledgements(), 1);
  assert.equal((await getKnowledgeCatalogExportJob(db, job.id))?.rowCount, 101);
  assert.equal(objects.size, 2);
});

test("stale enqueue recovery is throttled and a 24-hour-old job is replaced", async () => {
  const { sqlite, db } = migratedSqlite();
  clearCatalogFixtureData(sqlite);
  insertCatalogProducts(sqlite, 1);
  const { queue, sent } = fakeQueue();
  const createdAt = new Date(NOW);
  const first = await startKnowledgeCatalogExport(db, queue, createdAt);
  sent.length = 0;

  const recoveredAt = new Date(createdAt.getTime() + 3 * 60 * 1000);
  assert.equal(await recoverStaleKnowledgeCatalogExportJobs(db, queue, recoveredAt), 1);
  assert.equal(await recoverStaleKnowledgeCatalogExportJobs(db, queue, recoveredAt), 0);
  assert.equal(sent.length, 1);

  const replacementAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000 + 1);
  const replacement = await startKnowledgeCatalogExport(db, queue, replacementAt);
  assert.notEqual(replacement.id, first.id);
  assert.equal((await getKnowledgeCatalogExportJob(db, first.id))?.status, "failed");
  assert.equal((await getKnowledgeCatalogExportJob(db, replacement.id))?.status, "queued");
});

test("a failed stale-recovery send is retried after its enqueue reservation becomes stale", async () => {
  const { sqlite, db } = migratedSqlite();
  clearCatalogFixtureData(sqlite);
  insertCatalogProducts(sqlite, 1);
  const { queue, sent } = fakeQueue();
  const createdAt = new Date(NOW);
  const job = await startKnowledgeCatalogExport(db, queue, createdAt);
  sent.length = 0;

  let failedSendCount = 0;
  const failingQueue = {
    async send(
      _body: KnowledgeCatalogExportQueueMessage,
      _options?: QueueSendOptions,
    ): Promise<QueueSendResponse> {
      failedSendCount += 1;
      throw new Error("injected_stale_recovery_send_failure");
    },
  };
  const firstRecoveryAt = new Date(createdAt.getTime() + 3 * 60 * 1000);
  assert.equal(await recoverStaleKnowledgeCatalogExportJobs(db, failingQueue, firstRecoveryAt), 0);
  assert.equal(failedSendCount, 1);
  assert.equal(await recoverStaleKnowledgeCatalogExportJobs(db, queue, firstRecoveryAt), 0);
  assert.equal(sent.length, 0, "the successful caller cannot bypass the active reservation");

  const secondRecoveryAt = new Date(firstRecoveryAt.getTime() + 2 * 60 * 1000);
  assert.equal(await recoverStaleKnowledgeCatalogExportJobs(db, queue, secondRecoveryAt), 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.body, {
    kind: "knowledge_catalog_export",
    jobId: job.id,
    expectedAfterId: 0,
    expectedChunkCount: 0,
  });
  assert.equal((await getKnowledgeCatalogExportJob(db, job.id))?.status, "queued");
});

test("an expired claimant cannot advance after a newer lease owns the same cursor", async () => {
  const { sqlite, db } = migratedSqlite();
  clearCatalogFixtureData(sqlite);
  const [catalogProductId] = insertCatalogProducts(sqlite, 1);
  const { queue } = fakeQueue();
  const createdAt = new Date(NOW);
  const job = await startKnowledgeCatalogExport(db, queue, createdAt);
  const firstClaim = await claimKnowledgeCatalogExportJob(db, job.id, 0, 0, createdAt, 5);
  assert.ok(firstClaim);

  const reclaimedAt = new Date(createdAt.getTime() + 6 * 1000);
  const secondClaim = await claimKnowledgeCatalogExportJob(db, job.id, 0, 0, reclaimedAt, 60);
  assert.ok(secondClaim);
  const advancedAt = new Date(reclaimedAt.getTime() + 1000);
  assert.equal(
    await advanceKnowledgeCatalogExportJob(db, {
      jobId: job.id,
      leaseToken: firstClaim.leaseToken,
      expectedAfterId: 0,
      expectedChunkCount: 0,
      nextAfterId: catalogProductId,
      addedRows: 1,
      addedBytes: 10,
      hasMore: false,
      advancedAt,
    }),
    false,
  );
  assert.equal(
    await advanceKnowledgeCatalogExportJob(db, {
      jobId: job.id,
      leaseToken: secondClaim.leaseToken,
      expectedAfterId: 0,
      expectedChunkCount: 0,
      nextAfterId: catalogProductId,
      addedRows: 1,
      addedBytes: 10,
      hasMore: false,
      advancedAt,
    }),
    true,
  );
  const ready = await getKnowledgeCatalogExportJob(db, job.id);
  assert.equal(ready?.status, "ready");
  assert.equal(ready?.afterId, catalogProductId);
  assert.equal(ready?.chunkCount, 1);
  assert.equal(ready?.rowCount, 1);
  assert.equal(ready?.byteCount, 10);
});

test("a live-lease DLQ delivery is requeued and its queued-only failure CAS loses", async () => {
  const { sqlite, db } = migratedSqlite();
  clearCatalogFixtureData(sqlite);
  insertCatalogProducts(sqlite, 1);
  const { queue, sent } = fakeQueue();
  const { bucket } = fakeBucket();
  const job = await startKnowledgeCatalogExport(db, queue, new Date());
  const body = sent[0]?.body;
  assert.ok(body);
  assert.ok(await claimKnowledgeCatalogExportJob(db, job.id, 0, 0, new Date(), 60));

  const deadLetter = fakeMessage(body);
  const batch = {
    queue: "hifiscout-product-audit-export-dlq",
    messages: [deadLetter.message],
    ackAll() {},
    retryAll() {},
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  } satisfies MessageBatch<KnowledgeCatalogExportQueueMessage>;
  await consumeKnowledgeCatalogExportDeadLetterBatch(
    { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
    batch,
  );

  assert.equal(deadLetter.acknowledgements(), 1);
  assert.deepEqual(deadLetter.retries, []);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]?.body, body);
  assert.ok((sent[1]?.options?.delaySeconds || 0) > 0);
  assert.equal(
    await failQueuedKnowledgeCatalogExportJob(db, job.id, "queue_delivery_exhausted", new Date(), {
      afterId: 0,
      chunkCount: 0,
    }),
    false,
  );
  assert.equal((await getKnowledgeCatalogExportJob(db, job.id))?.status, "processing");
});

test("generation fails before a 901st chunk and download rejects an oversized manifest", async () => {
  const { sqlite, db } = migratedSqlite();
  clearCatalogFixtureData(sqlite);
  insertCatalogProducts(sqlite, 101);
  const { queue, sent } = fakeQueue();
  const { bucket } = fakeBucket();
  const job = await startKnowledgeCatalogExport(db, queue, new Date());
  sqlite
    .prepare("UPDATE knowledge_catalog_export_jobs SET chunk_count = ? WHERE id = ?")
    .run(KNOWLEDGE_CATALOG_EXPORT_MAX_CHUNKS - 1, job.id);
  sent.length = 0;
  const delivery = fakeMessage({
    kind: "knowledge_catalog_export",
    jobId: job.id,
    expectedAfterId: 0,
    expectedChunkCount: KNOWLEDGE_CATALOG_EXPORT_MAX_CHUNKS - 1,
  });
  assert.deepEqual(
    await consumeKnowledgeCatalogExportMessage(
      { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue },
      delivery.message,
    ),
    { status: "failed" },
  );
  assert.equal(delivery.acknowledgements(), 1);
  assert.equal(sent.length, 0);
  assert.equal(
    (await getKnowledgeCatalogExportJob(db, job.id))?.error,
    "knowledge_catalog_export_too_large",
  );

  sqlite
    .prepare(`
      UPDATE knowledge_catalog_export_jobs
      SET status = 'ready', chunk_count = ?, completed_at = ?, expires_at = ?
      WHERE id = ?
    `)
    .run(KNOWLEDGE_CATALOG_EXPORT_MAX_CHUNKS + 1, NOW, "2099-08-29T00:00:00.000Z", job.id);
  const response = await createKnowledgeCatalogExportDownloadResponse(db, bucket, job.id);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "knowledge_catalog_export_too_many_chunks" });
});
