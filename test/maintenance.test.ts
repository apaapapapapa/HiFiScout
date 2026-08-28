import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { retentionCutoffs, runRetentionCleanup } from "../src/maintenance.js";
import { asQueryableDatabase, captureDatabase } from "./helpers/d1.js";

test("retention cutoffs use conservative operational defaults", () => {
  const now = new Date("2026-08-11T00:00:00.000Z");
  const result = retentionCutoffs({}, now);

  assert.equal(result.settings.crawlRunRetentionDays, 30);
  assert.equal(result.settings.dataQualityRetentionDays, 180);
  assert.equal(result.settings.priceHistoryRetentionDays, 1095);
  assert.equal(result.settings.inactiveProductRetentionDays, 365);
  assert.equal(result.settings.deleteBatchSize, 500);
  assert.equal(result.crawlRunsBefore, "2026-07-12T00:00:00.000Z");
  assert.equal(result.dataQualityBefore, "2026-02-12T00:00:00.000Z");
  assert.equal(result.inactiveProductsBefore, "2025-08-11T00:00:00.000Z");
});

test("deleting an aged-out listing also retires the product it was the last offer for", async () => {
  const db = captureDatabase();
  const result = await runRetentionCleanup(
    { DB: db },
    { now: new Date("2026-08-11T00:00:00.000Z") },
  );

  const prune = db.calls.find((statement) =>
    /DELETE FROM product_search_entities/.test(statement.sql),
  );
  assert.ok(prune, "expected empty product entities to be pruned");
  assert.match(prune.sql, /NOT EXISTS[\s\S]*product_search_entity_offers/);
  assert.equal(result.deleted.emptySearchEntities, 1);
  // Order matters: pruning before the listing delete would leave the entity behind.
  const listingDelete = db.calls.findIndex((statement) =>
    /DELETE FROM products/.test(statement.sql),
  );
  assert.ok(listingDelete >= 0 && listingDelete < db.calls.indexOf(prune));
});

test("expired Product Audit exports are deleted in a bounded daily batch", async () => {
  const now = new Date("2026-08-11T00:00:00.000Z");
  const db = captureDatabase();
  const result = await runRetentionCleanup({ DB: db }, { now });

  const cleanup = db.calls.find((statement) =>
    /DELETE FROM product_audit_export_jobs/.test(statement.sql),
  );
  assert.ok(cleanup);
  assert.match(cleanup.sql, /expires_at IS NOT NULL AND expires_at <= \?/);
  assert.match(cleanup.sql, /ORDER BY expires_at ASC, id ASC[\s\S]*LIMIT \?/);
  assert.deepEqual(cleanup.binds, [now.toISOString(), 500]);
  assert.equal(result.deleted.productAuditExports, 1);
});

test("expired Knowledge Catalog exports are deleted in a bounded daily batch", async () => {
  const now = new Date("2026-08-11T00:00:00.000Z");
  const db = captureDatabase();
  const result = await runRetentionCleanup({ DB: db }, { now });

  const cleanup = db.calls.find((statement) =>
    /DELETE FROM knowledge_catalog_export_jobs/.test(statement.sql),
  );
  assert.ok(cleanup);
  assert.match(cleanup.sql, /expires_at IS NOT NULL AND expires_at <= \?/);
  assert.match(cleanup.sql, /ORDER BY expires_at ASC, id ASC[\s\S]*LIMIT \?/);
  assert.deepEqual(cleanup.binds, [now.toISOString(), 500]);
  assert.equal(result.deleted.knowledgeCatalogExports, 1);
});

test("retention delete batches are capped at 1000 rows", () => {
  const result = retentionCutoffs(
    { RETENTION_DELETE_BATCH_SIZE: "5000" },
    new Date("2026-08-11T00:00:00.000Z"),
  );
  assert.equal(result.settings.deleteBatchSize, 1000);
});

/**
 * D1 double whose deletes report a caller-chosen number of rows, so a multi-batch drain can be
 * observed. `captureDatabase` always reports one row, which cannot distinguish "batch was full,
 * keep going" from "horizon is clear".
 */
function deletingDatabase(changesFor: (sql: string, attempt: number) => number) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const attempts = new Map<string, number>();
  const db = asQueryableDatabase({
    calls,
    prepare(sql: string) {
      const record = (binds: unknown[]) => {
        calls.push({ sql, binds });
        const attempt = (attempts.get(sql) || 0) + 1;
        attempts.set(sql, attempt);
        // A `LIMIT ?` delete cannot report more rows than it was allowed to take. Capping here
        // keeps the double from letting a caller's arithmetic look correct against an impossible
        // answer, which is exactly the mistake a paging loop is prone to.
        const allowed = /LIMIT \?/.test(sql) ? Number(binds.at(-1)) : Number.POSITIVE_INFINITY;
        return {
          async all() {
            return { results: [] };
          },
          async first() {
            return null;
          },
          async run() {
            return {
              success: true,
              meta: { changes: Math.min(changesFor(sql, attempt), allowed) },
            };
          },
        };
      };
      return {
        bind: (...binds: unknown[]) => record(binds),
        all: () => record([]).all(),
        first: () => record([]).first(),
        run: () => record([]).run(),
      };
    },
    async batch(statements: { sql: string; binds: unknown[] }[]) {
      return statements.map(() => ({ success: true, meta: { changes: 0 } }));
    },
  });
  return { db, calls };
}

const REMEDIATION_DELETE = /DELETE FROM data_quality_remediation_queue/;

test("settled remediation jobs age out on their own short horizon", () => {
  const result = retentionCutoffs({}, new Date("2026-08-28T00:00:00.000Z"));

  // The queue accrues one row per active listing per resolver bump and never reuses a settled row,
  // so sharing the 180-day data-quality horizon meant nothing was eligible until the table held
  // over a million rows. Its own horizon is what keeps the table proportional to recent work.
  assert.equal(result.settings.remediationQueueRetentionDays, 7);
  assert.equal(result.remediationQueueBefore, "2026-08-21T00:00:00.000Z");
  assert.notEqual(result.remediationQueueBefore, result.dataQualityBefore);
});

test("a remediation backlog larger than one batch is drained across batches", async () => {
  const { db, calls } = deletingDatabase((sql, attempt) => {
    if (!REMEDIATION_DELETE.test(sql)) return 0;
    // Two full batches, then a short one: the horizon is clear at 1,100 rows.
    return attempt <= 2 ? 500 : 100;
  });

  const result = await runRetentionCleanup(
    { DB: db },
    { now: new Date("2026-08-28T00:00:00.000Z") },
  );

  assert.equal(result.deleted.remediationQueue, 1100);
  const deletes = calls.filter((statement) => REMEDIATION_DELETE.test(statement.sql));
  // Three statements, not one: a single capped delete could never outpace the queue's own accrual.
  assert.equal(deletes.length, 3);
  // The short third batch ends it — no wasted round trip confirming an already-clear horizon.
  assert.deepEqual(
    deletes.map((statement) => statement.binds[1]),
    [500, 500, 500],
  );
  assert.equal(deletes[0]?.binds[0], "2026-08-21T00:00:00.000Z");
});

test("one retention run never sheds more than its per-run limit", async () => {
  const { db, calls } = deletingDatabase((sql) => (REMEDIATION_DELETE.test(sql) ? 500 : 0));

  const result = await runRetentionCleanup(
    { DB: db, REMEDIATION_QUEUE_DELETE_LIMIT: "1200" },
    { now: new Date("2026-08-28T00:00:00.000Z") },
  );

  // A backlog that never returns a short batch must still terminate: the run stops at the limit and
  // leaves the rest for tomorrow rather than turning cleanup into an unbounded write.
  assert.equal(result.deleted.remediationQueue, 1200);
  const deletes = calls.filter((statement) => REMEDIATION_DELETE.test(statement.sql));
  assert.deepEqual(
    deletes.map((statement) => statement.binds[1]),
    [500, 500, 200],
  );
});
