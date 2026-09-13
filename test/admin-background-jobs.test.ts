import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { AdminJobs } from "../src/admin/background-jobs.js";
import { parseAdminJobCommand } from "../src/http/admin-jobs.js";
import { previewAdminCsvChange } from "../src/db/admin-csv-import-repository.js";
import { updateListingAdminProduct } from "../src/db/listing-admin-repository.js";
import type {
  AdminJobCommand,
  AdminJobDetail,
  AdminCsvApplyInput,
  AdminCsvChange,
} from "../src/api/admin-csv-contracts.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import { readCatalogReplaySnapshot } from "../src/db/admin-catalog-replay.js";
import { getCategory } from "../src/catalog/categories.js";

function harness() {
  const data = migratedSqlite();
  const local = new DatabaseSync(":memory:");
  const queries: string[] = [];
  let crashAfterApply = false;
  let crashModelCheckpoint = false;
  let beforeReplayWrite: (() => void) | undefined;
  let beforeCatalogApply: (() => void) | undefined;
  let afterBatch: (() => Promise<void>) | undefined;
  let alarm: number | null = null;
  const ctx = {
    storage: {
      sql: {
        exec(query: string, ...bindings: (string | number | null)[]) {
          queries.push(query);
          if (query.startsWith("SELECT fingerprint,applied_job_id")) {
            const callback = beforeCatalogApply;
            beforeCatalogApply = undefined;
            callback?.();
          }
          if (crashModelCheckpoint && query.startsWith("UPDATE model_replays SET pending_ids=")) {
            crashModelCheckpoint = false;
            throw new Error("simulated model checkpoint loss");
          }
          if (crashAfterApply && query.startsWith("UPDATE items SET state=")) {
            crashAfterApply = false;
            throw new Error("simulated receipt checkpoint loss");
          }
          if (query.startsWith("CREATE TABLE")) {
            local.exec(query);
            return { toArray: () => [] };
          }
          const rows = local.prepare(query).all(...bindings);
          return { toArray: () => rows };
        },
      },
      transactionSync<T>(callback: () => T) {
        local.exec("BEGIN IMMEDIATE");
        try {
          const result = callback();
          local.exec("COMMIT");
          return result;
        } catch (error) {
          local.exec("ROLLBACK");
          throw error;
        }
      },
      setAlarm: async (at: number) => {
        alarm = at;
      },
      deleteAlarm: async () => {
        alarm = null;
      },
    },
  } as unknown as DurableObjectState;
  const runtimeDb = {
    prepare(query: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
        ...statement,
        first: statement.first.bind(statement),
        all: statement.all.bind(statement),
        raw: statement.raw?.bind(statement),
        bind: (...values: unknown[]) => wrap(statement.bind(...values)),
        async run<T>() {
          if (query.includes("UPDATE products") && query.includes("SET manufacturer = ?")) {
            const callback = beforeReplayWrite;
            beforeReplayWrite = undefined;
            callback?.();
          }
          return statement.run<T>();
        },
      });
      return wrap(data.db.prepare(query));
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const result = await data.db.batch<T>(statements);
      const callback = afterBatch;
      afterBatch = undefined;
      await callback?.();
      return result;
    },
  };
  const create = () => new AdminJobs(ctx, { DB: runtimeDb } as unknown as Env);
  let worker = create();
  const command = async (value: AdminJobCommand, status = 200) => {
    const response = await worker.fetch(
      new Request("https://jobs/command", { method: "POST", body: JSON.stringify(value) }),
    );
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result as AdminJobDetail;
  };
  return {
    ...data,
    local,
    queries,
    command,
    crashAfterApply: () => {
      crashAfterApply = true;
    },
    crashModelCheckpoint: () => {
      crashModelCheckpoint = true;
    },
    beforeReplayWrite: (callback: () => void) => {
      beforeReplayWrite = callback;
    },
    beforeCatalogApply: (callback: () => void) => {
      beforeCatalogApply = callback;
    },
    afterBatch: (callback: () => Promise<void>) => {
      afterBatch = callback;
    },
    restart: () => {
      worker = create();
    },
    alarm: () => worker.alarm(),
    nextAlarm: () => alarm,
    close: () => {
      local.close();
      data.sqlite.close();
    },
  };
}

async function input(
  h: ReturnType<typeof harness>,
  id: number,
  value = "M-2",
): Promise<AdminCsvApplyInput> {
  h.sqlite
    .prepare(`INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at,
    canonical_manufacturer_id,manufacturer_id,manufacturer,model,normalized_model,primary_category_id)
    VALUES (?,'test',?,'Original title','https://example.test/item','','','','luxman','luxman','LUXMAN','M-1','M1','unclassified')`)
    .run(id, String(id));
  const values = { manufacturer_id: "luxman", model: "M-1", primary_category_id: "unclassified" };
  const change: AdminCsvChange = {
    line: id,
    original: { version: 1, kind: "listing", id, values },
    values: { ...values, model: value },
  };
  const preview = await previewAdminCsvChange(h.db, change);
  assert.equal(preview.status, "ready");
  return { change, revision: preview.revision!, operationId: crypto.randomUUID() };
}

test("an uploaded CSV waits for explicit start and survives worker and browser loss", async () => {
  const h = harness();
  try {
    const id = crypto.randomUUID();
    const items = [await input(h, 100001), await input(h, 100002)];
    const writes = h.sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    await h.command({ action: "create", id, kind: "csv", total: 2, label: "two listings" });
    await h.command({ action: "append", id, offset: 0, items });
    await h.command({ action: "append", id, offset: 0, items });
    assert.equal((await h.command({ action: "get", id })).job.uploaded, 2);
    assert.equal(h.sqlite.prepare("SELECT total_changes() AS n").get()?.n, writes);
    await h.command({ action: "start", id });
    h.restart();
    await h.alarm();
    const result = await h.command({ action: "get", id });
    assert.equal(result.job.status, "completed");
    assert.equal(result.job.processed, 2);
    assert.equal(result.job.failed, 0);
    assert.equal(
      h.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_csv_import_changes").get()?.n,
      2,
    );
    assert.equal(
      h.local.prepare("SELECT COUNT(*) AS n FROM items WHERE input_json IS NOT NULL").get()?.n,
      0,
    );
    await h.command({ action: "start", id });
    await h.alarm();
    assert.equal(
      h.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_csv_import_changes").get()?.n,
      2,
    );
  } finally {
    h.close();
  }
});

test("pause and resume retain the job cursor, and the coordinator processes at most five items", async () => {
  const h = harness();
  try {
    const id = crypto.randomUUID();
    const items = [];
    for (let n = 0; n < 7; n++) items.push(await input(h, 100001 + n));
    await h.command({ action: "create", id, kind: "csv", total: 7, label: "seven" });
    await h.command({ action: "append", id, offset: 0, items });
    await h.command({ action: "start", id });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.processed, 5);
    await h.command({ action: "pause", id });
    h.restart();
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.processed, 5);
    await h.command({ action: "resume", id });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.status, "completed");
  } finally {
    h.close();
  }
});

test("failed-only retry skips applied rows and never replaces a stale revision", async () => {
  const h = harness();
  try {
    const id = crypto.randomUUID();
    const items = [await input(h, 100001), await input(h, 100002)];
    h.sqlite.exec("UPDATE products SET model='Concurrent change' WHERE id=100002");
    await h.command({ action: "create", id, kind: "csv", total: 2, label: "conflict" });
    await h.command({ action: "append", id, offset: 0, items });
    await h.command({ action: "start", id });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.failed, 1);
    await h.command({ action: "retry", id });
    await h.alarm();
    const result = await h.command({ action: "get", id });
    assert.equal(result.job.processed, 2);
    assert.equal(result.job.failed, 1);
    assert.equal(result.items[1].result?.status, "conflict");
    const failures = await h.command({ action: "get", id, failedOnly: true });
    assert.deepEqual(
      failures.items.map((row) => row.ordinal),
      [1],
    );
    assert.equal(parseAdminJobCommand({ action: "get", id, failedOnly: "true" }), null);
    assert.equal(
      h.sqlite.prepare("SELECT model FROM products WHERE id=100002").get()?.model,
      "Concurrent change",
    );
    assert.equal(
      h.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_csv_import_changes").get()?.n,
      1,
    );
  } finally {
    h.close();
  }
});

test("partial upload, mutated retry and invalid commands do not start an import", async () => {
  const h = harness();
  try {
    const id = crypto.randomUUID();
    const item = await input(h, 100001);
    await h.command({ action: "create", id, kind: "csv", total: 2, label: "partial" });
    await h.command({ action: "append", id, offset: 0, items: [item] });
    await h.command({ action: "start", id }, 409);
    await h.command(
      { action: "append", id, offset: 0, items: [{ ...item, operationId: crypto.randomUUID() }] },
      409,
    );
    assert.equal(
      h.sqlite.prepare("SELECT model FROM products WHERE id=100001").get()?.model,
      "M-1",
    );
    assert.equal(parseAdminJobCommand({ action: ["pause"], id }), null);
    assert.equal(
      parseAdminJobCommand({ action: "create", id, kind: "csv", total: 225001, label: "large" }),
      null,
    );
    assert.equal(parseAdminJobCommand({ action: "get", id: "arbitrary" }), null);
  } finally {
    h.close();
  }
});

test("a lost job checkpoint reuses the D1 receipt and does not overwrite a later change", async () => {
  const h = harness();
  try {
    const id = crypto.randomUUID();
    const items = [await input(h, 100001)];
    await h.command({ action: "create", id, kind: "csv", total: 1, label: "crash" });
    await h.command({ action: "append", id, offset: 0, items });
    await h.command({ action: "start", id });
    h.crashAfterApply();
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.status, "failed");
    assert.equal(
      h.sqlite.prepare("SELECT model FROM products WHERE id=100001").get()?.model,
      "M-2",
    );
    await updateListingAdminProduct(h.db, 100001, { model: "Later correction" });
    h.restart();
    await h.command({ action: "resume", id });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.processed, 1);
    assert.equal(
      h.sqlite.prepare("SELECT model FROM products WHERE id=100001").get()?.model,
      "Later correction",
    );
    assert.equal(
      h.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_csv_import_changes").get()?.n,
      1,
    );
  } finally {
    h.close();
  }
});

test("pause received during a D1 update survives the completed bounded step", async () => {
  const h = harness();
  try {
    const id = crypto.randomUUID();
    const items = [await input(h, 100001), await input(h, 100002)];
    await h.command({ action: "create", id, kind: "csv", total: 2, label: "pause in flight" });
    await h.command({ action: "append", id, offset: 0, items });
    await h.command({ action: "start", id });
    h.afterBatch(async () => {
      await h.command({ action: "pause", id });
    });
    await h.alarm();
    const result = await h.command({ action: "get", id });
    assert.equal(result.job.status, "paused");
    assert.equal(result.job.processed, 1);
    assert.equal(
      h.sqlite.prepare("SELECT model FROM products WHERE id=100002").get()?.model,
      "M-1",
    );
  } finally {
    h.close();
  }
});

test("job history uses a page index and expired details are removed in bounded chunks", async () => {
  const h = harness();
  try {
    h.local.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<2000)
      INSERT INTO jobs(id,kind,label,status,created_at,updated_at,total,rule_version,expires_at,details_available)
      SELECT 'old-'||i,'csv','old','completed','2020-01-01','2020-01-01',0,1,'2020-01-08',0 FROM n`);
    const reads = h.sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    const response = (await h.command({ action: "list" })) as unknown as {
      items: unknown[];
      nextBefore: string;
    };
    assert.equal(response.items.length, 25);
    assert.ok(response.nextBefore);
    assert.equal(h.sqlite.prepare("SELECT total_changes() AS n").get()?.n, reads);
    const plan = h.local
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM jobs ORDER BY created_at DESC,id DESC LIMIT 26")
      .all();
    assert.match(JSON.stringify(plan), /jobs_recent/u);
    assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/u);
    const id = crypto.randomUUID();
    await h.command({ action: "create", id, kind: "csv", total: 1, label: "expired" });
    h.local.prepare("UPDATE jobs SET expires_at='2000-01-01' WHERE id=?").run(id);
    h.local
      .prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1500)
      INSERT INTO items(job_id,ordinal,input_json) SELECT ?,i,'{}' FROM n`)
      .run(id);
    const activeId = crypto.randomUUID();
    const inputs = [];
    for (let n = 0; n < 7; n++) inputs.push(await input(h, 100001 + n));
    await h.command({ action: "create", id: activeId, kind: "csv", total: 7, label: "ongoing" });
    await h.command({ action: "append", id: activeId, offset: 0, items: inputs });
    await h.command({ action: "start", id: activeId });
    await h.alarm();
    assert.equal(h.local.prepare("SELECT COUNT(*) AS n FROM items WHERE job_id=?").get(id)?.n, 500);
    assert.equal((await h.command({ action: "get", id: activeId })).job.processed, 5);
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.detailsAvailable, false);
    assert.equal((await h.command({ action: "get", id: activeId })).job.status, "completed");
  } finally {
    h.close();
  }
});

test("offer replay runs one bounded batch per alarm without a browser", async () => {
  const h = harness();
  try {
    for (let n = 0; n < 30; n++) await input(h, 100001 + n);
    const id = crypto.randomUUID();
    await h.command({ action: "create", id, kind: "replay", total: 0, label: "replay" });
    await h.command({ action: "start", id });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.processed, 25);
    h.restart();
    await h.alarm();
    const result = await h.command({ action: "get", id });
    assert.equal(result.job.processed, 30);
    assert.equal(result.job.status, "completed");
  } finally {
    h.close();
  }
});

test("replay stops after three stalled checkpoints and rejects a changed rule version", async () => {
  const h = harness();
  try {
    for (let n = 0; n < 30; n++) await input(h, 100001 + n);
    const id = crypto.randomUUID();
    await h.command({ action: "create", id, kind: "replay", total: 0, label: "stalled" });
    await h.command({ action: "start", id });
    for (let step = 0; step < 3; step++) {
      // Emulate a concurrent checkpoint that supplies no forward progress to the coordinator.
      h.afterBatch(async () => {
        h.sqlite.exec(
          "UPDATE product_offer_fact_replays SET after_id=0,scanned_count=0,completed_at=NULL",
        );
      });
      await h.alarm();
      const job = (await h.command({ action: "get", id })).job;
      assert.equal(job.processed, 0);
      assert.equal(job.status, step === 2 ? "failed" : "running");
    }
    assert.match((await h.command({ action: "get", id })).job.error, /進捗が更新されない/);
    h.local.prepare("UPDATE jobs SET rule_version=-1 WHERE id=?").run(id);
    await h.command({ action: "resume", id });
    await h.alarm();
    assert.match((await h.command({ action: "get", id })).job.error, /抽出ルールが更新/);
  } finally {
    h.close();
  }
});

test("manufacturer replay survives pause and restart while retaining manual correction authority", async () => {
  const { applyManufacturerRegistry, manufacturerRevision, registryVersion } =
    await import("../src/db/admin-manufacturer-management.js");
  const h = harness();
  try {
    h.sqlite.exec(
      "WITH RECURSIVE n(id) AS (VALUES(100001) UNION ALL SELECT id+1 FROM n WHERE id<100007) INSERT INTO products(id,shop_key,source_id,title,raw_manufacturer,raw_model,source_url,first_seen_at,last_seen_at,last_changed_at) SELECT id,'audiounion','brand-job-'||id,'デモラボ L-505','デモラボ','デモラボ L-505','https://example.test/','','','' FROM n",
    );
    h.sqlite.exec(
      "INSERT INTO product_admin_overrides(listing_product_id,model,normalized_model,created_at,updated_at) VALUES(100001,'手動型番','MANUAL','',''); UPDATE products SET model='手動型番',normalized_model='MANUAL' WHERE id=100001;",
    );
    const edit = {
      manufacturerId: "luxman",
      canonicalName: "LUXMAN",
      nameJa: "",
      nameEn: "",
      alias: { alias: "デモラボ", shopKey: "audiounion", enabled: true },
    };
    const id = crypto.randomUUID();
    await h.command(
      { action: "create", kind: "manufacturer", id, total: 0, label: "メーカー再判定" },
      409,
    );
    await applyManufacturerRegistry(
      h.db,
      edit,
      await manufacturerRevision(await registryVersion(h.db), edit),
      id,
    );
    await h.command({
      action: "create",
      kind: "manufacturer",
      id,
      total: 0,
      label: "メーカー再判定",
    });
    await h.command({ action: "start", id });
    h.afterBatch(async () => {
      await h.command({ action: "pause", id });
    });
    await h.alarm();
    let result = await h.command({ action: "get", id });
    assert.equal(result.job.status, "paused");
    assert.equal(result.job.processed, 5);
    h.restart();
    await h.command({ action: "resume", id });
    await h.alarm();
    result = await h.command({ action: "get", id });
    assert.equal(result.job.status, "completed");
    assert.equal(result.job.processed, 7);
    assert.equal(
      h.sqlite.prepare("SELECT canonical_manufacturer_id FROM products WHERE id=100007").get()
        ?.canonical_manufacturer_id,
      "luxman",
    );
    assert.equal(
      h.sqlite.prepare("SELECT model FROM products WHERE id=100001").get()?.model,
      "手動型番",
    );
    assert.equal(
      h.sqlite.prepare("SELECT raw_model FROM products WHERE id=100001").get()?.raw_model,
      "デモラボ L-505",
    );
  } finally {
    h.close();
  }
});

function modelListings(h: ReturnType<typeof harness>, count: number, start = 100001) {
  const insert = h.sqlite
    .prepare(`INSERT INTO products(id,shop_key,source_id,title,raw_manufacturer,raw_model,
    model,source_url,first_seen_at,last_seen_at,last_changed_at,price_yen,model_resolver_version)
    VALUES (?,'audiounion',?,'TAD D-1000 MK2 中古','TAD','D-1000 MK2 中古','古い型番',
      'https://example.test/model','2026-01-01','2026-01-02','2026-01-03',100000,1)`);
  for (let i = start; i < start + count; i++) insert.run(i, String(i));
}

function catalogListings(h: ReturnType<typeof harness>, count = 2) {
  h.sqlite.exec(`DELETE FROM knowledge_catalog_products;
    INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,verification_status,created_at,updated_at)
      VALUES ('luxman','LUXMAN','verified','','');`);
  const insert = h.sqlite
    .prepare(`INSERT INTO products(id,shop_key,source_id,title,raw_manufacturer,
    raw_model,manufacturer,manufacturer_id,canonical_manufacturer_id,model,normalized_model,
    model_resolution_status,source_url,first_seen_at,last_seen_at,last_changed_at,
    price_yen,model_resolver_version,metadata_json)
    VALUES (?,'audiounion',?,'LUXMAN TEST-700','LUXMAN','TEST-700','LUXMAN','luxman','luxman',
      'TEST-700','TEST700','resolved','https://example.test/catalog','','','',100000,?,?)`);
  for (let i = 0; i < count; i++)
    insert.run(
      100001 + i,
      String(100001 + i),
      RESOLUTION_VERSIONS.model,
      JSON.stringify({ categoryClassification: { version: RESOLUTION_VERSIONS.category } }),
    );
}

function addReplayCatalog(h: ReturnType<typeof harness>, model = "TEST-700", id = 900001) {
  h.sqlite
    .prepare(`INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,
    normalized_model,canonical_name,verification_status,created_at,updated_at,last_verified_at)
    VALUES (?,'luxman',?,?,?,'verified','','','2026-09-13')`)
    .run(id, model, model.replaceAll("-", ""), model);
  h.sqlite
    .prepare(`INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary)
    VALUES (?,?,1)`)
    .run(id, getCategory("pre_amp")!.id);
}

const catalogCommand = (id = crypto.randomUUID()): AdminJobCommand => ({
  action: "create",
  id,
  kind: "catalog",
  total: 0,
  label: "カタログ更新を登録商品に反映",
});

async function drainCatalog(h: ReturnType<typeof harness>, id = crypto.randomUUID()) {
  await h.command(catalogCommand(id));
  await h.command({ action: "start", id });
  for (let i = 0; i < 30; i++) {
    await h.alarm();
    const job = (await h.command({ action: "get", id })).job;
    if (job.status === "completed") return job;
    assert.notEqual(job.status, "failed", job.error);
  }
  assert.fail("catalog replay failed to drain bounded fixture");
}

test("catalog replay applies additions and category changes to current and inactive listings, then skips unchanged input", async () => {
  const h = harness();
  try {
    catalogListings(h);
    h.sqlite.exec("UPDATE products SET is_active=0 WHERE id=100002");
    await drainCatalog(h);
    addReplayCatalog(h);
    const added = await drainCatalog(h);
    assert.equal(added.processed, 2);
    assert.deepEqual(added.catalogReplay, { scanned: 2, skipped: 0 });
    assert.equal(
      h.sqlite
        .prepare(
          "SELECT COUNT(*) n FROM product_identity_resolutions WHERE catalog_product_id=900001 AND status='matched'",
        )
        .get()?.n,
      2,
    );
    assert.equal(
      h.sqlite
        .prepare("SELECT COUNT(*) n FROM products WHERE primary_category_id=?")
        .get(getCategory("pre_amp")!.id)?.n,
      2,
    );
    const before = h.sqlite.prepare("SELECT total_changes() n").get()?.n;
    const unchanged = await drainCatalog(h);
    assert.equal(unchanged.processed, 0);
    assert.deepEqual(unchanged.catalogReplay, { scanned: 2, skipped: 2 });
    assert.equal(h.sqlite.prepare("SELECT total_changes() n").get()?.n, before);
    // Same manufacturer, unrelated model: candidate-scoped receipts remain valid.
    addReplayCatalog(h, "OTHER-900", 900002);
    assert.equal((await drainCatalog(h)).processed, 0);
    h.sqlite
      .prepare(
        "UPDATE knowledge_catalog_product_categories SET category_id=? WHERE product_id=900001",
      )
      .run(getCategory("power_amp")!.id);
    assert.equal((await drainCatalog(h)).processed, 2);
    assert.equal(
      h.sqlite
        .prepare("SELECT COUNT(*) n FROM products WHERE primary_category_id=?")
        .get(getCategory("power_amp")!.id)?.n,
      2,
    );
    assert.equal(
      h.sqlite
        .prepare(
          "SELECT primary_category_id FROM product_search_entities WHERE entity_key='c-900001'",
        )
        .get()?.primary_category_id,
      getCategory("power_amp")!.id,
    );
  } finally {
    h.close();
  }
});

test("catalog replay invalidates aliases, ambiguous candidates, manual decisions and changed source without reacting to prices or observation dates", async () => {
  const h = harness();
  try {
    catalogListings(h, 1);
    addReplayCatalog(h, "OFFICIAL-700");
    await drainCatalog(h);
    h.sqlite
      .exec(`INSERT INTO knowledge_catalog_aliases(product_id,alias,normalized_alias,alias_type,created_at)
      VALUES (900001,'TEST-700','TEST700','model','');`);
    assert.equal((await drainCatalog(h)).processed, 1);
    assert.equal(
      h.sqlite
        .prepare(
          "SELECT catalog_product_id FROM product_identity_resolutions WHERE listing_product_id=100001",
        )
        .get()?.catalog_product_id,
      900001,
    );
    h.sqlite.exec(
      "UPDATE products SET price_yen=200000,last_seen_at='2026-09-15',last_changed_at='2026-09-15' WHERE id=100001",
    );
    assert.equal((await drainCatalog(h)).processed, 0);
    await updateListingAdminProduct(h.db, 100001, { primaryCategoryId: "dac" });
    assert.equal((await drainCatalog(h)).processed, 1);
    assert.equal(
      h.sqlite.prepare("SELECT primary_category_id FROM products WHERE id=100001").get()
        ?.primary_category_id,
      getCategory("dac")!.id,
    );
    h.sqlite.exec("UPDATE products SET title='LUXMAN TEST-700 専用ケース' WHERE id=100001");
    assert.equal((await drainCatalog(h)).processed, 1);
    assert.notEqual(
      h.sqlite
        .prepare("SELECT status FROM product_identity_resolutions WHERE listing_product_id=100001")
        .get()?.status,
      "matched",
    );
    h.sqlite.exec("UPDATE products SET title='LUXMAN TEST-700' WHERE id=100001");
    await drainCatalog(h);
    addReplayCatalog(h, "ANOTHER-700", 900002);
    h.sqlite
      .exec(`INSERT INTO knowledge_catalog_aliases(product_id,alias,normalized_alias,alias_type,created_at)
      VALUES (900002,'TEST-700','TEST700','model','');`);
    assert.equal((await drainCatalog(h)).processed, 1);
    assert.notEqual(
      h.sqlite
        .prepare("SELECT status FROM product_identity_resolutions WHERE listing_product_id=100001")
        .get()?.status,
      "matched",
    );
    h.sqlite.exec("DELETE FROM knowledge_catalog_aliases WHERE product_id=900002");
    assert.equal((await drainCatalog(h)).processed, 1);
    h.sqlite.exec(
      "UPDATE knowledge_catalog_products SET verification_status='rejected' WHERE id=900001",
    );
    assert.equal((await drainCatalog(h)).processed, 1);
    assert.notEqual(
      h.sqlite
        .prepare("SELECT status FROM product_identity_resolutions WHERE listing_product_id=100001")
        .get()?.status,
      "matched",
    );
  } finally {
    h.close();
  }
});

test("catalog replay reuses cursors, persists receipts across checkpoint loss, and resumes after pause and deployment", async () => {
  const h = harness();
  try {
    catalogListings(h);
    const id = crypto.randomUUID();
    await h.command(catalogCommand(id));
    assert.equal((await h.command(catalogCommand())).job.id, id);
    assert.notEqual((await h.command(modelCommand())).job.id, id);
    await h.command({ action: "start", id });
    h.crashModelCheckpoint();
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.status, "failed");
    const writes = h.sqlite.prepare("SELECT total_changes() n").get()?.n;
    assert.equal(h.local.prepare("SELECT COUNT(*) n FROM catalog_replay_marks").get()?.n, 1);
    h.restart();
    await h.command({ action: "resume", id });
    await h.alarm();
    assert.equal(h.sqlite.prepare("SELECT total_changes() n").get()?.n, writes);
    assert.equal((await h.command({ action: "get", id })).job.processed, 1);
    await h.command({ action: "pause", id });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.status, "paused");
    await h.command({ action: "resume", id });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.status, "completed");
    const next = crypto.randomUUID();
    await h.command(catalogCommand(next));
    h.local.prepare("UPDATE model_replays SET versions_json='{}' WHERE job_id=?").run(next);
    await h.command({ action: "resume", id: next }, 409);
    await h.command({ action: "start", id: next });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id: next })).job.status, "failed");
    assert.match(
      (await h.command({ action: "get", id: next })).job.error,
      /判定ルールまたは対象範囲/,
    );
  } finally {
    h.close();
  }
});

test("catalog replay retries catalog changes during a step and never records failed downstream work as current", async () => {
  const h = harness();
  try {
    catalogListings(h, 1);
    addReplayCatalog(h);
    const id = crypto.randomUUID();
    await h.command(catalogCommand(id));
    await h.command({ action: "start", id });
    h.beforeCatalogApply(() => {
      h.sqlite
        .prepare(
          "UPDATE knowledge_catalog_product_categories SET category_id=? WHERE product_id=900001",
        )
        .run(getCategory("power_amp")!.id);
    });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.status, "queued");
    assert.equal(h.local.prepare("SELECT COUNT(*) n FROM catalog_replay_marks").get()?.n, 0);
    h.beforeCatalogApply(() => {
      h.afterBatch(async () => {
        throw new Error("projection unavailable");
      });
    });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.status, "failed");
    assert.equal(h.local.prepare("SELECT COUNT(*) n FROM catalog_replay_marks").get()?.n, 0);
    await h.command({ action: "resume", id });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.status, "completed");
    const snapshot = await readCatalogReplaySnapshot(h.db, 100001);
    assert.equal(
      h.local
        .prepare("SELECT fingerprint FROM catalog_replay_marks WHERE listing_product_id=100001")
        .get()?.fingerprint,
      snapshot?.fingerprint,
    );
    assert.equal(
      h.sqlite.prepare("SELECT primary_category_id FROM products WHERE id=100001").get()
        ?.primary_category_id,
      getCategory("power_amp")!.id,
    );
  } finally {
    h.close();
  }
});

const modelCommand = (id = crypto.randomUUID()): AdminJobCommand => ({
  action: "create",
  id,
  kind: "model",
  total: 0,
  label: "型番再判定",
});

test("model replay persists one candidate window, respects pause and snapshot bounds, and preserves manual fields", async () => {
  const h = harness();
  try {
    modelListings(h, 4);
    h.sqlite
      .exec(`INSERT INTO product_admin_overrides(listing_product_id,model,normalized_model,created_at,updated_at)
      VALUES(100001,'手動型番','MANUAL','',''); UPDATE products SET model='手動型番',normalized_model='MANUAL' WHERE id=100001;
      UPDATE products SET is_active=0 WHERE id=100004;`);
    const id = crypto.randomUUID();
    await h.command(modelCommand(id));
    await h.command({ action: "start", id });
    await h.alarm();
    const first = (await h.command({ action: "get", id })).job;
    assert.equal(first.processed, 1);
    assert.deepEqual(first.modelReplay, {
      version: RESOLUTION_VERSIONS.model,
      categoryVersion: RESOLUTION_VERSIONS.category,
      scanned: 4,
    });
    assert.equal(first.status, "running");
    assert.equal(
      h.sqlite.prepare("SELECT model FROM products WHERE id=100001").get()?.model,
      "手動型番",
    );
    assert.equal(
      h.sqlite.prepare("SELECT model_resolver_version FROM products WHERE id=100002").get()
        ?.model_resolver_version,
      1,
    );
    await h.command({ action: "pause", id });
    h.restart();
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.processed, 1);
    modelListings(h, 1, 100005);
    await h.command({ action: "resume", id });
    await h.alarm();
    await h.alarm();
    const completed = (await h.command({ action: "get", id })).job;
    assert.equal(completed.status, "completed");
    assert.equal(completed.processed, 3);
    assert.equal(completed.modelReplay?.scanned, 4);
    const row = h.sqlite.prepare("SELECT * FROM products WHERE id=100002").get()!;
    assert.equal(row.model_resolver_version, RESOLUTION_VERSIONS.model);
    assert.equal(row.manufacturer_resolver_version, RESOLUTION_VERSIONS.manufacturer);
    assert.equal(row.raw_model, "D-1000 MK2 中古");
    assert.equal(row.price_yen, 100000);
    assert.equal(row.last_seen_at, "2026-01-02");
    assert.equal(row.remediation_projection_required, 0);
    assert.equal(
      h.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM product_search_entity_offers WHERE listing_product_id IN (100001,100002,100003)",
        )
        .get()?.n,
      3,
    );
    assert.equal(
      h.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM products WHERE id IN (100004,100005) AND model_resolver_version=1",
        )
        .get()?.n,
      2,
    );
  } finally {
    h.close();
  }
});

test("category-only drift replays retained evidence and search categories while preserving manual categories", async () => {
  const h = harness();
  try {
    modelListings(h, 4);
    h.sqlite
      .prepare(`UPDATE products SET title='SONY オープンリールテープ SLH-550',
      raw_manufacturer='SONY',raw_model='SLH-550',model='SLH-550',raw_category='オープンリールテープ',
      category='テープデッキ',primary_category_id='ANA.TAPE',model_resolver_version=?,metadata_json=?`)
      .run(
        RESOLUTION_VERSIONS.model,
        JSON.stringify({ categoryClassification: { version: RESOLUTION_VERSIONS.category - 1 } }),
      );
    h.sqlite
      .prepare(
        "UPDATE products SET metadata_json=json_set(metadata_json,'$.categoryClassification.version',?) WHERE id=100003",
      )
      .run(RESOLUTION_VERSIONS.category);
    h.sqlite.exec("UPDATE products SET is_active=0 WHERE id=100004");
    await updateListingAdminProduct(h.db, 100002, { primaryCategoryId: "ACC.PART" });
    const id = crypto.randomUUID();
    await h.command(modelCommand(id));
    await h.command({ action: "start", id });
    await h.alarm();
    await h.command({ action: "pause", id });
    h.restart();
    await h.command({ action: "resume", id });
    await h.alarm();
    const result = (await h.command({ action: "get", id })).job;
    assert.equal(result.status, "completed");
    assert.equal(result.processed, 2);
    for (const [listingId, category] of [
      [100001, "REC.MEDIA"],
      [100002, "ACC.PART"],
    ] as const) {
      const row = h.sqlite.prepare("SELECT * FROM products WHERE id=?").get(listingId)!;
      assert.equal(row.primary_category_id, category);
      assert.equal(row.model_resolver_version, RESOLUTION_VERSIONS.model);
      assert.equal(
        JSON.parse(String(row.metadata_json)).categoryClassification.version,
        RESOLUTION_VERSIONS.category,
      );
      assert.equal(row.raw_category, "オープンリールテープ");
      assert.equal(row.remediation_projection_required, 0);
      assert.equal(
        h.sqlite
          .prepare(`SELECT COUNT(*) AS n FROM product_search_entity_offers o
        JOIN product_search_entity_categories c ON c.entity_id=o.entity_id
        WHERE o.listing_product_id=? AND c.category_id=?`)
          .get(listingId, category)?.n,
        1,
        `listing ${listingId}: ${category}`,
      );
    }
    assert.equal(
      h.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM products WHERE id IN (100003,100004) AND primary_category_id='ANA.TAPE'",
        )
        .get()?.n,
      2,
    );
  } finally {
    h.close();
  }
});

test("model-only saved cursors stop and cannot hide category drift from a new combined replay", async () => {
  const h = harness();
  try {
    modelListings(h, 2);
    h.sqlite.prepare("UPDATE products SET model_resolver_version=?").run(RESOLUTION_VERSIONS.model);
    const oldId = crypto.randomUUID();
    await h.command(modelCommand(oldId));
    // Pre-upgrade state has exactly the same rule tuple, but skipped these category-only rows.
    h.local
      .prepare(`UPDATE model_replays SET versions_json=?,max_product_id=100002,
      after_id=100002,scanned_count=2,scan_complete=1 WHERE job_id=?`)
      .run(JSON.stringify(RESOLUTION_VERSIONS), oldId);
    await h.command({ action: "start", id: oldId });
    h.restart();
    const writes = h.sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    await h.alarm();
    const oldJob = (await h.command({ action: "get", id: oldId })).job;
    assert.equal(oldJob.status, "failed");
    assert.match(oldJob.error, /対象範囲が更新/);
    assert.equal(oldJob.modelReplay?.categoryVersion, undefined);
    assert.equal(h.sqlite.prepare("SELECT total_changes() AS n").get()?.n, writes);
    await h.command({ action: "resume", id: oldId }, 409);
    const newId = (await h.command(modelCommand())).job.id;
    assert.notEqual(newId, oldId);
    await h.command({ action: "start", id: newId });
    await h.alarm();
    await h.alarm();
    const completed = (await h.command({ action: "get", id: newId })).job;
    assert.equal(completed.status, "completed");
    assert.equal(completed.processed, 2);
    assert.equal(completed.modelReplay?.categoryVersion, RESOLUTION_VERSIONS.category);
  } finally {
    h.close();
  }
});

test("model replay scans an all-current tail in bounded windows and coalesces repeated submissions", async () => {
  const h = harness();
  try {
    modelListings(h, 51);
    h.sqlite
      .prepare("UPDATE products SET model_resolver_version=?,metadata_json=?")
      .run(
        RESOLUTION_VERSIONS.model,
        JSON.stringify({ categoryClassification: { version: RESOLUTION_VERSIONS.category } }),
      );
    const writes = h.sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    const id = crypto.randomUUID();
    await h.command(modelCommand(id));
    assert.equal((await h.command(modelCommand())).job.id, id);
    await h.command({ action: "start", id });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.modelReplay?.scanned, 25);
    h.restart();
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.modelReplay?.scanned, 50);
    await h.alarm();
    const job = (await h.command({ action: "get", id })).job;
    assert.equal(job.status, "completed");
    assert.equal(job.processed, 0);
    assert.equal(job.modelReplay?.scanned, 51);
    assert.equal(h.sqlite.prepare("SELECT total_changes() AS n").get()?.n, writes);
    assert.equal(parseAdminJobCommand({ ...modelCommand(), total: 1 }), null);
  } finally {
    h.close();
  }
});

test("model replay recovers lost checkpoints without double counting or repeating completed D1 writes", async () => {
  const h = harness();
  try {
    modelListings(h, 2);
    const id = crypto.randomUUID();
    await h.command(modelCommand(id));
    await h.command({ action: "start", id });
    h.crashModelCheckpoint();
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.status, "failed");
    assert.equal((await h.command(modelCommand())).job.id, id);
    assert.equal(
      h.sqlite.prepare("SELECT model_resolver_version FROM products WHERE id=100001").get()
        ?.model_resolver_version,
      RESOLUTION_VERSIONS.model,
    );
    const writes = h.sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    h.restart();
    await h.command({ action: "resume", id });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.processed, 1);
    assert.equal(h.sqlite.prepare("SELECT total_changes() AS n").get()?.n, writes);
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.processed, 2);
    assert.equal((await h.command({ action: "get", id })).job.status, "completed");
  } finally {
    h.close();
  }
});

test("model replay retains failed projection work and an in-flight pause, then rejects a changed resolver tuple", async () => {
  const h = harness();
  try {
    modelListings(h, 2);
    const id = crypto.randomUUID();
    await h.command(modelCommand(id));
    await h.command({ action: "start", id });
    h.afterBatch(async () => {
      throw new Error("D1 unavailable after derived update");
    });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.status, "failed");
    assert.equal(
      h.sqlite.prepare("SELECT remediation_projection_required FROM products WHERE id=100001").get()
        ?.remediation_projection_required,
      1,
    );
    await h.command({ action: "resume", id });
    h.afterBatch(async () => {
      await h.command({ action: "pause", id });
    });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.status, "paused");
    assert.equal((await h.command({ action: "get", id })).job.processed, 1);
    const writes = h.sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    h.local.prepare("UPDATE model_replays SET versions_json=? WHERE job_id=?").run(
      JSON.stringify({
        ...JSON.parse(
          String(
            h.local.prepare("SELECT versions_json FROM model_replays WHERE job_id=?").get(id)!
              .versions_json,
          ),
        ),
        category: -1,
      }),
      id,
    );
    assert.equal((await h.command({ action: "get", id })).job.modelReplay?.categoryVersion, -1);
    await h.command({ action: "resume", id }, 409);
    h.local.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(id);
    h.restart();
    await h.alarm();
    assert.match(
      (await h.command({ action: "get", id })).job.error,
      /判定ルールまたは対象範囲が更新/,
    );
    assert.equal(h.sqlite.prepare("SELECT total_changes() AS n").get()?.n, writes);
    await h.command({ action: "cancel", id });
    assert.notEqual((await h.command(modelCommand())).job.id, id);
  } finally {
    h.close();
  }
});

test("a concurrent crawl fences old replay input and the saved candidate retries fresh evidence", async () => {
  const h = harness();
  try {
    modelListings(h, 1);
    const id = crypto.randomUUID();
    await h.command(modelCommand(id));
    await h.command({ action: "start", id });
    h.beforeReplayWrite(() => {
      h.sqlite
        .prepare(`UPDATE products SET raw_manufacturer='LUXMAN',manufacturer='LUXMAN',
        raw_model='L-505Z',model='L-505Z',normalized_model='L505Z',title='LUXMAN L-505Z',
        canonical_manufacturer_id='luxman',manufacturer_id='luxman',
        metadata_json='{"crawl":"new"}',model_resolver_version=?,
        remediation_projection_token='newer-crawl',remediation_projection_required=1 WHERE id=100001`)
        .run(RESOLUTION_VERSIONS.model);
    });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.status, "queued");
    assert.equal((await h.command({ action: "get", id })).job.processed, 0);
    const fresh = h.sqlite.prepare("SELECT * FROM products WHERE id=100001").get()!;
    assert.equal(fresh.model, "L-505Z");
    assert.equal(fresh.raw_model, "L-505Z");
    assert.equal(fresh.canonical_manufacturer_id, "luxman");
    assert.equal(fresh.metadata_json, '{"crawl":"new"}');
    assert.equal(fresh.remediation_projection_token, "newer-crawl");
    assert.equal(
      h.sqlite.prepare("SELECT COUNT(*) AS n FROM product_search_entity_offers").get()?.n,
      0,
    );
    h.restart();
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.status, "completed");
    assert.equal((await h.command({ action: "get", id })).job.processed, 1);
    assert.equal(
      h.sqlite.prepare("SELECT model FROM products WHERE id=100001").get()?.model,
      "L-505Z",
    );
    assert.equal(
      h.sqlite.prepare("SELECT remediation_projection_required FROM products WHERE id=100001").get()
        ?.remediation_projection_required,
      0,
    );
  } finally {
    h.close();
  }
});

test("repeated source conflicts stop bounded retries without advancing the model candidate", async () => {
  const h = harness();
  try {
    modelListings(h, 1);
    const id = crypto.randomUUID();
    await h.command(modelCommand(id));
    await h.command({ action: "start", id });
    for (let n = 0; n < 3; n++) {
      h.beforeReplayWrite(() => {
        h.sqlite
          .prepare("UPDATE products SET title=? WHERE id=100001")
          .run(`TAD D-1000 MK2 新着${n}`);
      });
      await h.alarm();
    }
    const job = (await h.command({ action: "get", id })).job;
    assert.equal(job.status, "failed");
    assert.equal(job.processed, 0);
    assert.match(job.error, /競合が続く/);
    await h.command({ action: "resume", id });
    await h.alarm();
    assert.equal((await h.command({ action: "get", id })).job.status, "completed");
  } finally {
    h.close();
  }
});
