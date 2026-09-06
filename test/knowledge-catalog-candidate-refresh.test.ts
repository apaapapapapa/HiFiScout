import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { invocationBudget, InvocationBudgetExceeded } from "../src/db/invocation-budget.js";
import { prepareScheduledKnowledgeCatalogCandidates } from "../src/db/knowledge-catalog-candidate-refresh.js";
import {
  enqueueMaintenance,
  pendingMaintenance,
} from "../src/db/scheduled-maintenance-repository.js";
import { dispatchKnowledgeCatalogDailyVerification } from "../src/knowledge-catalog/dispatch.js";
import { runPendingMaintenance } from "../src/scheduled.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { queueBinding, queueEnv } from "./helpers/knowledge-queue.js";

const AT = new Date("2030-01-01T00:00:00.000Z");

test("2,845 candidates resume across Cron budgets before one review run is dispatched", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(`DELETE FROM knowledge_catalog_products;
      WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 2845)
      INSERT INTO products(shop_key, source_id, title, manufacturer, canonical_manufacturer_id, model,
        source_url, first_seen_at, last_seen_at, last_changed_at, is_active)
      SELECT 'shop', CAST(i AS TEXT), 'Model '||i, 'LUXMAN', 'luxman', 'L-'||i,
        'https://example.test/'||i, '2029-01-01', '2029-01-01', '2029-01-01', 1 FROM n;
      INSERT INTO knowledge_catalog_candidates(manufacturer_id, normalized_model, active_listing_count,
        last_reviewed_at, created_at, updated_at)
      VALUES ('luxman', 'VANISHED', 1, '2029-01-01', '2029-01-01', '2029-01-01');`);
    const name = "daily_catalog_verification";
    await enqueueMaintenance(db, [name], AT);
    const queue = queueBinding();
    const registry = [
      {
        name,
        run: (env: Env, now: Date) => dispatchKnowledgeCatalogDailyVerification(env, { now }),
      },
    ];
    let completed = false;
    for (let tick = 0; tick < 150; tick++) {
      const now = new Date(AT.getTime() + tick * 5 * 60_000);
      const budget = invocationBudget(db, {
        maxCalls: 45,
        finalizationReserve: 5,
        maxWallMs: 60_000,
      });
      await runPendingMaintenance(queueEnv(budget.db, queue.binding) as Env, now, budget, registry);
      assert.ok(budget.metrics().d1Calls <= 45);
      const state = sqlite.prepare("SELECT * FROM knowledge_catalog_candidate_refresh").get();
      if (tick === 0) {
        assert.ok(Number(state?.listing_cursor) > 0 && Number(state?.listing_cursor) < 2845);
        assert.equal(
          sqlite.prepare("SELECT COUNT(*) n FROM knowledge_catalog_review_runs").get()?.n,
          0,
        );
      }
      if (state?.phase === "collect" || state?.phase === "publish") {
        assert.equal(
          sqlite
            .prepare(
              "SELECT active_listing_count FROM knowledge_catalog_candidates WHERE normalized_model='VANISHED'",
            )
            .get()?.active_listing_count,
          1,
        );
        assert.equal(queue.sent.length, 0);
      }
      if (!(await pendingMaintenance(db, new Date(now.getTime() + 5 * 60_000))).length) {
        completed = true;
        break;
      }
    }
    assert.ok(completed, "bounded work must eventually finish, not replay its first batch forever");
    assert.equal(queue.sent.length, 1);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) n FROM knowledge_catalog_review_runs").get()?.n,
      1,
    );
    assert.equal(
      sqlite.prepare("SELECT SUM(active_listing_count) n FROM knowledge_catalog_candidates").get()
        ?.n,
      2845,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) n FROM knowledge_catalog_candidate_refresh_groups").get()?.n,
      0,
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT active_listing_count FROM knowledge_catalog_candidates WHERE normalized_model='VANISHED'",
        )
        .get()?.active_listing_count,
      0,
    );
    // A second scheduled consumer of this day's projection does no full scan or checkpoint write.
    const cached = invocationBudget(db, { maxCalls: 1 });
    await prepareScheduledKnowledgeCatalogCandidates(cached.db, AT);
    assert.equal(cached.metrics().d1Calls, 1);
  } finally {
    sqlite.close();
  }
});

test("a committed page with a lost acknowledgement resumes without double-counting a cross-page group", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(`DELETE FROM knowledge_catalog_products;
      WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 205)
      INSERT INTO products(shop_key, source_id, title, manufacturer, canonical_manufacturer_id, model,
        raw_model, source_url, first_seen_at, last_seen_at, last_changed_at, is_active)
      SELECT CASE WHEN i%2=0 THEN 'one' ELSE 'two' END, CAST(i AS TEXT), 'Title '||i, 'LUXMAN', 'luxman',
        CASE WHEN i%2=0 THEN 'Ｃ－１０' ELSE 'C - 10' END, 'raw '||i,
        'https://example.test/'||i, '2029-01-01', '2029-01-01', '2029-01-01', 1 FROM n;`);
    let lost = false;
    const flaky: QueryableDatabase = {
      ...db,
      async batch<T>(statements: D1PreparedStatement[]) {
        const result = await db.batch<T>(statements);
        if (!lost) {
          lost = true;
          throw new Error("lost acknowledgement");
        }
        return result;
      },
    };
    await assert.rejects(
      prepareScheduledKnowledgeCatalogCandidates(flaky, AT),
      /lost acknowledgement/,
    );
    assert.equal(
      sqlite.prepare("SELECT listing_cursor FROM knowledge_catalog_candidate_refresh").get()
        ?.listing_cursor,
      100,
    );
    for (let tick = 0; tick < 30; tick++) {
      const budget = invocationBudget(db, { maxCalls: 12 });
      try {
        await prepareScheduledKnowledgeCatalogCandidates(budget.db, AT);
        break;
      } catch (error) {
        assert.ok(error instanceof InvocationBudgetExceeded);
      }
    }
    const row = sqlite.prepare("SELECT * FROM knowledge_catalog_candidates").get();
    assert.equal(row?.active_listing_count, 205);
    assert.equal(row?.shop_count, 2);
    assert.equal(row?.normalized_model, "C-10");
    assert.equal(JSON.parse(String(row?.raw_model_variants)).length, 10);
    assert.equal(JSON.parse(String(row?.evidence_source_urls)).length, 5);
    assert.equal(row?.sample_title, "Title 205");
  } finally {
    sqlite.close();
  }
});

test("concurrent refresh continuations fence stale accumulator and cursor writes", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(`DELETE FROM knowledge_catalog_products;
      WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 220)
      INSERT INTO products(shop_key, source_id, title, manufacturer, canonical_manufacturer_id, model,
        source_url, first_seen_at, last_seen_at, last_changed_at, is_active)
      SELECT 'shop', CAST(i AS TEXT), 'Title', 'LUXMAN', 'luxman', 'C10',
        'https://example.test/'||i, '2029-01-01', '2029-01-01', '2029-01-01', 1 FROM n;`);
    // D1 serializes statements and atomic batches. The SQLite helper uses one connection, so
    // serialize here as well rather than allowing a second BEGIN inside the first transaction.
    let pending: Promise<unknown> = Promise.resolve();
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
      const next = pending.then(work);
      pending = next.catch(() => {});
      return next;
    };
    const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
      const wrapped = {
        ...statement,
        bind: (...values: unknown[]) => wrap(statement.bind(...values)),
        all: <T>() => serial(() => statement.all<T>()),
        first: <T>(column?: string) =>
          serial(() => (column === undefined ? statement.first<T>() : statement.first<T>(column))),
        run: <T>() => serial(() => statement.run<T>()),
      } as D1PreparedStatement;
      originals.set(wrapped, statement);
      return wrapped;
    };
    const concurrent: QueryableDatabase = {
      prepare: (sql) => wrap(db.prepare(sql)),
      batch: <T>(statements: D1PreparedStatement[]) =>
        serial(() => db.batch<T>(statements.map((statement) => originals.get(statement)!))),
    };
    await Promise.all([
      prepareScheduledKnowledgeCatalogCandidates(concurrent, AT),
      prepareScheduledKnowledgeCatalogCandidates(concurrent, AT),
    ]);
    assert.equal(
      sqlite.prepare("SELECT active_listing_count FROM knowledge_catalog_candidates").get()
        ?.active_listing_count,
      220,
    );
    assert.equal(
      sqlite.prepare("SELECT phase FROM knowledge_catalog_candidate_refresh").get()?.phase,
      "complete",
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) n FROM knowledge_catalog_candidate_refresh_groups").get()?.n,
      0,
    );
  } finally {
    sqlite.close();
  }
});
