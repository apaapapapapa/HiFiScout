import assert from "node:assert/strict";
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
  // `batch` runs the statements it is given, so handing it wrapped ones would record each twice --
  // once here, once when the batch calls its `run`. The originals go to the batch instead.
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (sql: string, binds: SQLInputValue[]) => {
    const statement = inner.prepare(sql).bind(...binds);
    const remember = () => executed.push({ sql, binds });
    const wrapped = {
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
    originals.set(wrapped, statement);
    return wrapped;
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
        return inner.batch(
          (statements as object[]).map(
            (statement) => originals.get(statement) ?? (statement as D1PreparedStatement),
          ),
        );
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
 * Tables the plan reads row by row, ignoring the ones a caller declares acceptable.
 *
 * `SCAN` alone is SQLite's wording for "read every row of the table b-tree". The qualified forms
 * are not that, and conflating them turns this whole harness into noise:
 *
 * - `SCAN t USING INDEX i` / `USING COVERING INDEX i` walks an index in order. It reads every entry,
 *   but through the index the schema provides — which is exactly what these tests are asking for.
 * - `SCAN t VIRTUAL TABLE INDEX 0:M1` is an FTS5 `MATCH`, i.e. the full-text index doing its job.
 *
 * Only a bare `SCAN <table>` is reported.
 */
export function unindexedScans(
  plan: readonly PlanStep[],
  allowed: readonly string[] = [],
): string[] {
  const scans: string[] = [];
  for (const step of plan) {
    const table = /^SCAN (\w+)\s*(.*)$/.exec(step.detail);
    if (!table) continue;
    const [, name, qualifier] = table;
    if (allowed.includes(name)) continue;
    if (/\b(USING\s+(COVERING\s+)?INDEX|VIRTUAL TABLE INDEX)\b/.test(qualifier)) continue;
    scans.push(name);
  }
  return [...new Set(scans)];
}

/**
 * Whether the plan answers from the index alone, never visiting the table's rows.
 *
 * Stronger than {@link readsThroughIndex}, and the difference is worth asserting where a query
 * selects only indexed columns: adding one column the index does not carry silently turns a
 * covering walk into one that fetches every matching row, at the same `USING INDEX` wording.
 */
export function readsThroughCoveringIndex(
  plan: readonly PlanStep[],
  table: string,
  index: string,
): boolean {
  return plan.some((step) =>
    new RegExp(`^(SCAN|SEARCH) ${table}\\b.*USING COVERING INDEX ${index}\\b`).test(step.detail),
  );
}

/** Whether the plan reads `table` through the named index, rather than however it likes. */
export function readsThroughIndex(
  plan: readonly PlanStep[],
  table: string,
  index: string,
): boolean {
  return plan.some((step) =>
    new RegExp(`^(SCAN|SEARCH) ${table}\\b.*USING (COVERING )?INDEX ${index}\\b`).test(step.detail),
  );
}

/**
 * An accepted row-by-row read, tied to the one statement that performs it.
 *
 * `when` is what keeps an exception honest. An allowance listed for the whole recorded workload
 * would also excuse a *different* query that starts scanning the same table, which is the opposite
 * of what these tests are for.
 */
export interface ScanAllowance {
  /** Table or alias, as the plan names it. */
  readonly tables: readonly string[];
  /** The statement the allowance covers. */
  readonly when: RegExp;
  readonly reason: string;
}

/**
 * The statements whose plan is worth checking.
 *
 * `WITH` and `INSERT ... SELECT` are included deliberately: a selector that picks rows is often a
 * CTE feeding an insert, and matching only bare `SELECT` would skip exactly those.
 */
export function selects(executed: readonly ExecutedStatement[]): ExecutedStatement[] {
  return executed.filter((statement) =>
    /^\s*(SELECT|WITH|INSERT[\s\S]*\bSELECT\b)/i.test(statement.sql),
  );
}

/** Constant-size reference tables; reading one end to end costs nothing that grows. */
export const SMALL_REFERENCE_TABLES = [
  "knowledge_catalog_products",
  "knowledge_catalog_product_categories",
  "knowledge_catalog_aliases",
  "knowledge_catalog_manufacturers",
  "knowledge_catalog_manufacturer_aliases",
];

/**
 * Asserts every statement a repository issued reads the growing tables through an index.
 *
 * Allowances are matched against each statement individually, so an exception granted for one query
 * cannot silently cover a different one that starts scanning the same table.
 */
export function assertNoGrowingTableScans(
  sqlite: DatabaseSync,
  executed: readonly ExecutedStatement[],
  { allowances = [] as ScanAllowance[], label = "" } = {},
): void {
  const inspected = selects(executed);
  assert.ok(inspected.length > 0, `${label}: nothing was executed, so nothing was proven`);
  const applied = new Set<ScanAllowance>();
  for (const statement of inspected) {
    const matching = allowances.filter((allowance) => allowance.when.test(statement.sql));
    for (const allowance of matching) applied.add(allowance);
    const scans = unindexedScans(queryPlan(sqlite, statement), [
      ...SMALL_REFERENCE_TABLES,
      ...matching.flatMap((allowance) => allowance.tables),
    ]);
    assert.deepEqual(
      scans,
      [],
      `${label}: full table read of ${scans.join(", ")} in\n${statement.sql.trim()}`,
    );
  }
  // An allowance nobody needed is a fix that landed without its record being removed.
  for (const allowance of allowances) {
    assert.ok(
      applied.has(allowance),
      `${label}: no statement matched the recorded allowance for ${allowance.tables.join(", ")} — ` +
        "if the query no longer scans, delete the allowance entry",
    );
  }
}

/**
 * Asserts nothing sorts before its `LIMIT`.
 *
 * Reading through an index is not yet a bounded read. A sort between the index and the `LIMIT`
 * means every matching row is visited before any can be discarded, which is how a query stays
 * proportional to the table while looking perfectly indexed.
 */
export function assertNoSortBeforeLimit(
  sqlite: DatabaseSync,
  executed: readonly ExecutedStatement[],
  label = "",
): void {
  for (const statement of selects(executed)) {
    const plan = queryPlan(sqlite, statement);
    const sorted = plan.filter((step) => /USE TEMP B-TREE FOR ORDER BY/.test(step.detail));
    assert.deepEqual(
      sorted.map((step) => step.detail),
      [],
      `${label}: sorts before its LIMIT, so the LIMIT cannot bound it:\n${plan
        .map((step) => step.detail)
        .join("\n")}\n${statement.sql.trim()}`,
    );
  }
}
