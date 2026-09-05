import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "vite-plus/test";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import {
  createCompleteExportPlan,
  readCompleteExportPage,
  completeCsvCell,
} from "../src/export/complete-csv.js";
import { createCompleteArchiveDownloadResponse } from "../src/export/complete-archive.js";
import { COMPLETE_ARCHIVE_PART_CHUNKS } from "../src/export/contracts.js";
import { crc32 } from "../src/export/zip.js";
import { consumeProductAuditExportMessage } from "../src/product-audit-export/consumer.js";
import {
  startProductAuditExport,
  createProductAuditExportDownloadResponse,
} from "../src/product-audit-export/service.js";
import { startKnowledgeCatalogExport } from "../src/knowledge-catalog-export/service.js";
import { getProductAuditExportJob } from "../src/db/product-audit-export-job-repository.js";
import { productAuditExportChunkKey } from "../src/product-audit-export/csv.js";
import type { ProductAuditExportQueueMessage } from "../src/product-audit-export/types.js";
import { localD1 } from "./helpers/local-d1.js";

const NOW = new Date();

/** Independent stdlib parsers verify ZIP directories/CRCs and multiline CSV quoting. */
function unzip(bytes: Uint8Array): Record<string, string> {
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `
import sys,io,zipfile,json,base64
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
 assert z.testzip() is None
 print(json.dumps({n:base64.b64encode(z.read(n)).decode() for n in z.namelist()}))
`,
      ],
      { input: bytes, maxBuffer: 32 * 1024 * 1024 },
    ).toString(),
  );
}

function parseCsv(bytes: Uint8Array): string[][] {
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `
import sys,io,csv,json
csv.field_size_limit(16*1024*1024)
print(json.dumps(list(csv.reader(io.StringIO(sys.stdin.buffer.read().decode('utf-8-sig'),newline='')))))
`,
      ],
      { input: bytes, maxBuffer: 32 * 1024 * 1024 },
    ).toString(),
  );
}

function restoreText(value: string): string {
  return (value.startsWith("'") ? value.slice(1) : value).replace(
    /\\([\\0])/gu,
    (_, char: string) => (char === "0" ? "\0" : "\\"),
  );
}

function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  const readKeys: string[] = [];
  function object(key: string, range?: { offset?: number; length?: number }) {
    const value = objects.get(key);
    if (!value) return null;
    const bytes = range
      ? value.bytes.slice(
          range.offset ?? 0,
          (range.offset ?? 0) + (range.length ?? value.bytes.length),
        )
      : value.bytes;
    const response = new Response(new Uint8Array(bytes));
    return {
      key,
      size: value.bytes.byteLength,
      etag: String(crc32(value.bytes)),
      customMetadata: value.metadata,
      body: response.body!,
      text: () => response.text(),
      arrayBuffer: () => response.arrayBuffer(),
    };
  }
  const bucket = {
    async head(key: string) {
      return object(key);
    },
    async get(key: string, options?: R2GetOptions) {
      readKeys.push(key);
      return object(key, options?.range as { offset?: number; length?: number } | undefined);
    },
    async put(key: string, bytes: Uint8Array, options?: R2PutOptions) {
      if (objects.has(key) && options?.onlyIf) return null;
      objects.set(key, { bytes: new Uint8Array(bytes), metadata: { ...options?.customMetadata } });
      return object(key);
    },
  } as unknown as R2Bucket;
  return { bucket, objects, readKeys };
}

test("full table CSV preserves future/generated columns, exact SQL types, NULs and whole long values", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(`CREATE TABLE product_future_data (
      id INTEGER PRIMARY KEY, value TEXT, integer_value INTEGER, blob_value BLOB,
      real_value REAL, null_value TEXT, empty_value TEXT, generated_value TEXT GENERATED ALWAYS AS (id || '-generated') VIRTUAL
    )`);
    const text = '  =Formula\r\nquote" slash\\0 nul\0終' + "終".repeat(400_000);
    sqlite
      .prepare(
        "INSERT INTO product_future_data(id,value,integer_value,blob_value,real_value,empty_value) VALUES (1,?,9223372036854775806,?,1.2345678901234567,'')",
      )
      .run(text, new Uint8Array([0, 1, 255]));
    sqlite.prepare("INSERT INTO product_future_data(id,value) VALUES (2,?)").run(text);
    const plan = await createCompleteExportPlan(db, "all", 0);
    const table = plan.tables.findIndex((table) => table.name === "product_future_data");
    const first = await readCompleteExportPage(db, plan, { table, after: null });
    assert.equal(first.rows, 1, "byte budget limits rows per step, never cell content");
    const [headers, row] = parseCsv(first.bytes);
    const columns = sqlite
      .prepare("PRAGMA table_xinfo(product_future_data)")
      .all()
      .map((column) => column.name);
    assert.deepEqual(headers.slice(0, -1), columns);
    assert.equal(restoreText(row[1]), text);
    assert.equal(row[2], "9223372036854775806");
    assert.equal(row[3], "0001FF");
    assert.equal(Number(row[4]), 1.2345678901234567);
    assert.equal(row[5], "\\N");
    assert.equal(row[6], "");
    assert.equal(row[7], "1-generated");
    assert.equal(row[8], "itibrntt");
    assert.equal((await readCompleteExportPage(db, plan, first.next)).rows, 1);
    for (const value of [
      "",
      "'already",
      "\\N",
      "\0",
      "\t=1",
      "\r\n@SUM(1)",
      "+1",
      "-1",
      "00123",
      "=1",
      "\\\\0",
    ]) {
      assert.equal(
        restoreText(parseCsv(new TextEncoder().encode(completeCsvCell(value)))[0][0]),
        value,
      );
    }
    sqlite.exec("ALTER TABLE product_future_data ADD COLUMN later TEXT");
    await assert.rejects(readCompleteExportPage(db, plan, first.next), /schema_changed/u);
  } finally {
    sqlite.close();
  }
});

test("complete jobs preserve all child rows, retry deterministically, copy evidence and download valid ZIPs", async () => {
  const { db, sqlite } = migratedSqlite();
  const { bucket, objects, readKeys } = memoryBucket();
  try {
    sqlite.exec(`INSERT INTO products (id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at)
      VALUES (1,'test','1','original title','https://test.invalid/1','now','now','now');
      INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
      VALUES (9999,'test','Model','model','Name','now','now');`);
    for (let i = 0; i < 61; i += 1) {
      sqlite
        .prepare(
          "INSERT INTO knowledge_catalog_aliases(product_id,alias,normalized_alias,alias_type,created_at) VALUES (9999,?,?,'model','now')",
        )
        .run(`alias ${i}`, `alias${i}`);
      sqlite
        .prepare(
          "INSERT INTO knowledge_catalog_sources(product_id,source_type,source_url,retrieved_at,content_hash,status,created_at,updated_at) VALUES (9999,'manufacturer_official',?,'now','','active','now','now')",
        )
        .run(`https://test.invalid/${i}`);
      sqlite
        .prepare(
          "INSERT INTO knowledge_catalog_verification_attempts(product_id,manufacturer_id,normalized_model,source_type,source_url,attempted_at,status,message) VALUES (9999,'test','model','manufacturer_official',?,'now','verified',?)",
        )
        .run(`https://test.invalid/${i}`, `attempt ${i}`);
    }
    for (let i = 0; i < 1001; i += 1)
      sqlite
        .prepare("INSERT INTO price_history(product_id,price_yen,observed_at) VALUES (1,?,?)")
        .run(i, String(i));
    const evidence = new Uint8Array(2 * 1024 * 1024 + 37).fill(0x42);
    await bucket.put("retained-evidence", evidence);
    for (const key of ["retained-evidence", "expired-evidence"])
      sqlite
        .prepare(`INSERT INTO evidence_archive
      (shop_key,product_id,reason,content_hash,r2_object_key,content_type,captured_at,content_bytes)
      VALUES ('test',1,'temporary_debug_snapshot',?,?,'text/html','now',?)`)
        .run(key, key, evidence.length);

    const sent: ProductAuditExportQueueMessage[] = [];
    let failSend = false;
    const queue = {
      async send(body: ProductAuditExportQueueMessage) {
        if (failSend) {
          failSend = false;
          throw new Error("injected send failure");
        }
        sent.push(body);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    };
    const job = await startProductAuditExport(db, queue, "all", NOW);
    assert.equal(job.format, "complete");
    const catalog = await startKnowledgeCatalogExport(
      db,
      {
        async send() {
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      },
      NOW,
    );
    assert.equal(catalog.format, "complete");
    const env = { DB: db, EVIDENCE_BUCKET: bucket, PRODUCT_AUDIT_EXPORT_QUEUE: queue };
    const first = sent.shift()!;
    function message(
      body: ProductAuditExportQueueMessage,
    ): Message<ProductAuditExportQueueMessage> {
      return { body, id: "test", attempts: 1, timestamp: NOW, ack() {}, retry() {} };
    }
    failSend = true;
    assert.equal((await consumeProductAuditExportMessage(env, message(first))).status, "retrying");
    const firstBytes = objects.get(productAuditExportChunkKey(job.id, 0))!.bytes.slice();
    sqlite.exec("UPDATE products SET title = 'changed after durable chunk' WHERE id = 1");
    assert.equal((await consumeProductAuditExportMessage(env, message(first))).status, "continued");
    assert.deepEqual(objects.get(productAuditExportChunkKey(job.id, 0))!.bytes, firstBytes);
    assert.equal((await consumeProductAuditExportMessage(env, message(first))).status, "ignored");
    let steps = 0;
    while (sent.length) {
      assert.ok(steps++ < 150, "bounded continuation must terminate");
      const result = await consumeProductAuditExportMessage(env, message(sent.shift()!));
      assert.ok(["continued", "completed"].includes(result.status), result.status);
    }
    const ready = await getProductAuditExportJob(db, job.id);
    assert.equal(ready?.status, "ready");
    assert.ok(ready.afterId > ready.maxListingId, "archive cursor is independent of root IDs");
    const response = await createProductAuditExportDownloadResponse(db, bucket, job.id, NOW);
    assert.equal(response.headers.get("content-type"), "application/zip");
    const files = unzip(new Uint8Array(await response.arrayBuffer()));
    const manifest = JSON.parse(Buffer.from(files["manifest.json"], "base64").toString());
    for (const table of manifest.tables) {
      const expected = Number(
        sqlite.prepare(`SELECT COUNT(*) AS count FROM "${table.name}"`).get()!.count,
      );
      const actual = manifest.files
        .filter((file: { name: string }) => file.name.startsWith(`${table.name}/`))
        .reduce((sum: number, file: { rows: number }) => sum + file.rows, 0);
      assert.equal(actual, expected, `no missing rows in ${table.name}`);
    }
    const evidenceFiles = manifest.files.filter(
      (file: { evidence?: { status: string } }) => file.evidence?.status === "copied",
    );
    assert.equal(evidenceFiles.length, 2, "large evidence is copied in whole, bounded byte ranges");
    assert.deepEqual(
      Buffer.concat(
        evidenceFiles.map((file: { name: string }) => Buffer.from(files[file.name], "base64")),
      ),
      Buffer.from(evidence),
    );
    assert.equal(
      manifest.files.filter(
        (file: { evidence?: { status: string } }) => file.evidence?.status === "unavailable",
      ).length,
      1,
    );
    assert.ok(
      manifest.files.find((file: { name: string }) =>
        file.name.startsWith("knowledge_catalog_aliases/"),
      ).rows >= 61,
    );

    // A large dataset is split into download volumes instead of rejecting/truncating at 900 chunks.
    const original = objects.get(productAuditExportChunkKey(job.id, 0))!;
    const index = COMPLETE_ARCHIVE_PART_CHUNKS;
    const metadata = JSON.parse(original.metadata.complete);
    objects.set(productAuditExportChunkKey(job.id, index), {
      bytes: original.bytes,
      metadata: {
        complete: JSON.stringify({ ...metadata, index, name: `products/part-${index + 1}.csv` }),
      },
    });
    const many = { ...ready, chunkCount: index + 1 };
    readKeys.length = 0;
    const part2 = await createCompleteArchiveDownloadResponse(
      many,
      bucket,
      productAuditExportChunkKey,
      "complete.csv",
      2,
      NOW,
    );
    const secondFiles = unzip(new Uint8Array(await part2.arrayBuffer()));
    assert.equal(Object.keys(secondFiles).length, 2);
    assert.equal(
      JSON.parse(Buffer.from(secondFiles["manifest.json"], "base64").toString()).volumes,
      2,
    );
    assert.equal(readKeys.length, 2, "read only the plan and selected volume's objects");
    assert.equal(
      (
        await createCompleteArchiveDownloadResponse(
          many,
          bucket,
          productAuditExportChunkKey,
          "complete.csv",
          3,
          NOW,
        )
      ).status,
      400,
    );
    objects.delete(productAuditExportChunkKey(job.id, index));
    const broken = await createCompleteArchiveDownloadResponse(
      many,
      bucket,
      productAuditExportChunkKey,
      "complete.csv",
      2,
      NOW,
    );
    await assert.rejects(broken.arrayBuffer(), /chunk_missing/u);
  } finally {
    sqlite.close();
  }
});

test("real D1 exports generated columns, binary/large integers and single-key WITHOUT ROWID tables", async () => {
  const { db, dispose } = await localD1();
  try {
    await db
      .prepare(`CREATE TABLE products(id INTEGER PRIMARY KEY, value TEXT, binary_value BLOB,
      exact_integer INTEGER, is_active INTEGER, generated_value TEXT GENERATED ALWAYS AS (id || '-generated') VIRTUAL)`)
      .run();
    await db
      .prepare("CREATE TABLE product_named_facts(name TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID")
      .run();
    await db.prepare("INSERT INTO product_named_facts VALUES ('key','fact')").run();
    const value = "'\\N\0改行\r\n" + "証跡".repeat(30_000);
    await db
      .prepare(
        "INSERT INTO products(id,value,binary_value,exact_integer,is_active) VALUES (1,?,?,9007199254740993,1)",
      )
      .bind(value, new Uint8Array([0, 255, 128]))
      .run();
    await db.prepare("INSERT INTO products(id,value,is_active) VALUES (2,'inactive',0)").run();
    const plan = await createCompleteExportPlan(db, "active", 2);
    await db.prepare("INSERT INTO products(id,value,is_active) VALUES (3,'after horizon',1)").run();
    const first = await readCompleteExportPage(db, plan, { table: 0, after: null });
    const [headers, row] = parseCsv(first.bytes);
    assert.equal(first.rows, 1);
    assert.deepEqual(headers, [
      "id",
      "value",
      "binary_value",
      "exact_integer",
      "is_active",
      "generated_value",
      "__sqlite_types",
    ]);
    assert.equal(restoreText(row[1]), value);
    assert.equal(row[2], "00FF80");
    assert.equal(row[3], "9007199254740993");
    const next = await readCompleteExportPage(db, plan, first.next);
    assert.deepEqual(parseCsv(next.bytes)[1], ["key", "fact", "tt"]);
  } finally {
    await dispose();
  }
});
