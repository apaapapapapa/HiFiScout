import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { QueryableDatabase } from "../../src/db/types.js";
import { asQueryableDatabase } from "./d1.js";

/**
 * Records the SQL a repository really executes, so its plan can be inspected afterwards.
 *
 * Asserting on index DDL only proves an index exists. Whether a query *uses* it is a property of
 * the planner, and the only honest way to check is to explain the statement the repository
 * actually issued — not a copy of it written in a test, which drifts the moment the repository
 * changes.
 */

export interface ExecutedStatement {
  readonly sql: string;
  readonly binds: readonly SQLInputValue[];
}

export interface RecordingDatabase {
  readonly db: QueryableDatabase;
  /** Every statement that was executed, in order. */
  readonly executed: ExecutedStatement[];
}

export function recordingDatabase(inner: QueryableDatabase): RecordingDatabase {
  const executed: ExecutedStatement[] = [];
  const wrap = (sql: string, binds: SQLInputValue[]) => {
    const statement = inner.prepare(sql).bind(...binds);
    const remember = () => executed.push({ sql, binds });
    return {
      sql,
      binds,
      bind: (...next: SQLInputValue[]) => wrap(sql, next),
      async all<T>() {
        remember();
        return statement.all<T>();
      },
      async first<T>() {
        remember();
        return statement.first<T>();
      },
      async run() {
        remember();
        return statement.run();
      },
    };
  };
  return {
    executed,
    db: asQueryableDatabase({
      prepare: (sql: string) => wrap(sql, []),
      // Batched statements are recorded too: several repositories issue their real work through
      // `batch()`, and skipping it would silently leave those plans unchecked.
      batch(statements: unknown[]) {
        for (const statement of statements as ExecutedStatement[]) {
          executed.push({ sql: statement.sql, binds: statement.binds });
        }
        return inner.batch(statements as D1PreparedStatement[]);
      },
    }),
  };
}

/** One line of `EXPLAIN QUERY PLAN` output. */
export interface PlanStep {
  readonly detail: string;
}

/**
 * The plan SQLite chooses for a statement, with the binds it was issued with.
 *
 * Binds matter: a planner decision can depend on whether a parameter is used in a range or an
 * equality, so explaining with placeholders left unbound would not describe the real query.
 */
export function queryPlan(sqlite: DatabaseSync, statement: ExecutedStatement): readonly PlanStep[] {
  const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.binds);
  return rows.map((row) => ({ detail: String(row.detail ?? "") }));
}

/**
 * Tables the plan reads without an index, ignoring the ones a caller declares acceptable.
 *
 * `SCAN <table>` is SQLite's own wording for "read every row". Small constant tables and deliberate
 * aggregate sweeps are legitimate; a scan of a table that grows with the catalog is not.
 */
export function unindexedScans(
  plan: readonly PlanStep[],
  allowed: readonly string[] = [],
): string[] {
  const scans: string[] = [];
  for (const step of plan) {
    const table = /^SCAN (\w+)/.exec(step.detail)?.[1];
    if (!table || allowed.includes(table)) continue;
    // SQLite words an FTS5 MATCH as `SCAN <table> VIRTUAL TABLE INDEX 0:M1`. That is the full-text
    // index doing its job, not a row-by-row read, so it must not be counted as a scan.
    if (/VIRTUAL TABLE INDEX \d+:\w/.test(step.detail)) continue;
    scans.push(table);
  }
  return [...new Set(scans)];
}
