import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  accountReads,
  dbUsageMetrics,
  firstMeasured,
  sumDbUsageMetrics,
} from "../src/db/read-accounting.js";
import { asQueryableDatabase } from "./helpers/d1.js";

interface Recorded {
  sql: string;
  binds: unknown[];
}

/** A database that reports the row counts D1 reports, so the wrapper has something to add up. */
function meteredDatabase(
  rowsPerStatement: Record<string, { read: number; written: number }>,
  rows: unknown[] = [],
) {
  const statements: Recorded[] = [];
  const build = (sql: string, binds: unknown[]) => {
    const usage = rowsPerStatement[sql] ?? { read: 0, written: 0 };
    const result = {
      results: rows,
      meta: { rows_read: usage.read, rows_written: usage.written },
    };
    const statement = {
      sql,
      bind: (...next: unknown[]) => build(sql, next),
      async all() {
        statements.push({ sql, binds });
        return result;
      },
      async run() {
        statements.push({ sql, binds });
        return result;
      },
      async first() {
        statements.push({ sql, binds });
        // D1 returns the row itself here, with no meta to count.
        return null;
      },
    };
    return statement;
  };
  const db = asQueryableDatabase({
    statements,
    prepare: (sql: string) => build(sql, []),
    async batch(list: { run(): Promise<unknown> }[]) {
      return Promise.all(list.map((statement) => statement.run()));
    },
  });
  return db as typeof db & { statements: Recorded[] };
}

test("accounting adds up the rows D1 reports for all() and run()", async () => {
  const source = meteredDatabase({
    "SELECT scan": { read: 8000, written: 0 },
    "UPDATE thing": { read: 3, written: 1 },
  });
  const accounting = accountReads(source);

  await accounting.db.prepare("SELECT scan").bind(1).all();
  await accounting.db.prepare("UPDATE thing").bind(2).run();

  assert.equal(accounting.rowsRead(), 8003);
  assert.equal(accounting.rowsWritten(), 1);
  assert.equal(accounting.countedStatements(), 2);
  assert.equal(accounting.statementCount(), 2);
  assert.equal(accounting.returnedRows(), 0);
  assert.ok(accounting.durationMs() >= 0);
});

test("accounting adds up every statement in a batch", async () => {
  const source = meteredDatabase({ "UPDATE thing": { read: 5, written: 2 } });
  const accounting = accountReads(source);

  await accounting.db.batch([
    accounting.db.prepare("UPDATE thing"),
    accounting.db.prepare("UPDATE thing"),
  ]);

  assert.equal(accounting.rowsRead(), 10);
  assert.equal(accounting.rowsWritten(), 4);
});

test("accounting leaves the wrapped database's behaviour alone", async () => {
  const source = meteredDatabase({ "SELECT scan": { read: 7, written: 0 } });
  const accounting = accountReads(source);

  await accounting.db.prepare("SELECT scan").bind("a", "b").all();
  assert.equal(await accounting.db.prepare("SELECT scan").first(), null);

  assert.deepEqual(source.statements, [
    { sql: "SELECT scan", binds: ["a", "b"] },
    { sql: "SELECT scan", binds: [] },
  ]);
});

test("failed statements still contribute to statement count and duration", async () => {
  const source = asQueryableDatabase({
    prepare: () => ({
      async all() {
        throw new Error("D1 unavailable");
      },
    }),
  });
  const accounting = accountReads(source);

  await assert.rejects(accounting.db.prepare("SELECT scan").all(), /D1 unavailable/u);

  assert.equal(accounting.statementCount(), 1);
  assert.equal(accounting.countedStatements(), 0);
  assert.ok(accounting.durationMs() >= 0);
});

test("a first() call is not counted, so a total is a lower bound", async () => {
  const source = meteredDatabase({ "SELECT scan": { read: 7, written: 0 } });
  const accounting = accountReads(source);

  await accounting.db.prepare("SELECT scan").first();

  // D1 returns no meta for first(); reporting 0 here is honest, inventing a number would not be.
  assert.equal(accounting.rowsRead(), 0);
  assert.equal(accounting.countedStatements(), 0);
});

test("firstMeasured counts the reads a first() call would have hidden", async () => {
  // The statements worth measuring are the ones that return one row and read the whole table, so
  // the un-countable call was covering exactly the wrong half of the budget.
  const source = meteredDatabase({ "SELECT COUNT(*)": { read: 8000, written: 0 } });
  const accounting = accountReads(source);

  await firstMeasured(accounting.db.prepare("SELECT COUNT(*)"));

  assert.equal(accounting.rowsRead(), 8000);
  assert.equal(accounting.countedStatements(), 1);
});

test("firstMeasured returns the first row, or null over an empty result", async () => {
  const source = accountReads(
    meteredDatabase({ "SELECT one": { read: 1, written: 0 } }, [{ gap_count: 3 }]),
  );
  const empty = accountReads(meteredDatabase({ "SELECT none": { read: 1, written: 0 } }));

  assert.deepEqual(await firstMeasured(source.db.prepare("SELECT one")), { gap_count: 3 });
  assert.equal(await firstMeasured(empty.db.prepare("SELECT none")), null);
});

test("usage snapshots combine independently measured query groups", async () => {
  const staged = accountReads(
    meteredDatabase({ "SELECT staged": { read: 30, written: 0 } }, [{ page: 1 }]),
  );
  const existing = accountReads(
    meteredDatabase({ "SELECT existing": { read: 4, written: 0 } }, [{ listing: 1 }]),
  );

  await staged.db.prepare("SELECT staged").all();
  await existing.db.prepare("SELECT existing").all();

  const total = sumDbUsageMetrics(dbUsageMetrics(staged), dbUsageMetrics(existing));
  assert.equal(total.rowsRead, 34);
  assert.equal(total.rowsWritten, 0);
  assert.equal(total.statementCount, 2);
  assert.equal(total.returnedRows, 2);
  assert.ok(total.durationMs >= 0);
});
