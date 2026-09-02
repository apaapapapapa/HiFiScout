import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { accountReads } from "../src/db/read-accounting.js";
import { asQueryableDatabase } from "./helpers/d1.js";

interface Recorded {
  sql: string;
  binds: unknown[];
}

/** A database that reports the row counts D1 reports, so the wrapper has something to add up. */
function meteredDatabase(rowsPerStatement: Record<string, { read: number; written: number }>) {
  const statements: Recorded[] = [];
  const build = (sql: string, binds: unknown[]) => {
    const usage = rowsPerStatement[sql] ?? { read: 0, written: 0 };
    const result = {
      results: [],
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

test("a first() call is not counted, so a total is a lower bound", async () => {
  const source = meteredDatabase({ "SELECT scan": { read: 7, written: 0 } });
  const accounting = accountReads(source);

  await accounting.db.prepare("SELECT scan").first();

  // D1 returns no meta for first(); reporting 0 here is honest, inventing a number would not be.
  assert.equal(accounting.rowsRead(), 0);
  assert.equal(accounting.countedStatements(), 0);
});
