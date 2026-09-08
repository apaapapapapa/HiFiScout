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

function harness() {
  const data = migratedSqlite();
  const local = new DatabaseSync(":memory:");
  const queries: string[] = [];
  let crashAfterApply = false;
  let afterBatch: (() => Promise<void>) | undefined;
  let alarm: number | null = null;
  const ctx = {
    storage: {
      sql: {
        exec(query: string, ...bindings: (string | number | null)[]) {
          queries.push(query);
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
    prepare: data.db.prepare.bind(data.db),
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
