/**
 * What a piece of work actually costs D1.
 *
 * D1 bills reads by rows examined, not rows returned, so the expensive statements are rarely the
 * ones that look expensive in the code: an unindexed predicate or a view whose CTEs cannot take the
 * caller's filter reads the whole table while returning nothing. That cost is invisible from the
 * Worker unless it is asked for, which is how a scheduled task can quietly consume a day's budget.
 *
 * Every D1 result carries `meta.rows_read`. This wraps a database so a caller can run its normal
 * work and then ask what that work read.
 *
 * `first()` is deliberately a pass-through: D1 returns the row itself there, with no `meta`, so its
 * reads cannot be counted without changing the call into `all()`. A wrapper cannot make that change
 * on the caller's behalf -- `first()` and `all()` return different shapes -- so the call site has to
 * opt in, which is what {@link firstMeasured} is for. Anything still calling `first()` directly is
 * uncounted, and a total is a lower bound to that extent.
 */

import type { QueryableDatabase, ReadableDatabase } from "./types.js";

/** The subset of `meta` this cares about; absent fields simply do not contribute. */
interface CountedResult {
  meta?: { rows_read?: number | null; rows_written?: number | null } | null;
}

export interface ReadAccounting<TDatabase extends ReadableDatabase = QueryableDatabase> {
  /** Hand this to the work being measured; it behaves exactly like the database it wraps. */
  readonly db: TDatabase;
  /** Rows D1 reported reading, across every counted statement so far. */
  rowsRead(): number;
  /** Rows D1 reported writing, across every counted statement so far. */
  rowsWritten(): number;
  /** How many statements reported a count, so a zero total can be told from no measurement. */
  countedStatements(): number;
  /** How many measurable statements were attempted, including failures and results without meta. */
  statementCount(): number;
  /** Rows returned to the Worker across measured statements. */
  returnedRows(): number;
  /** Wall time spent awaiting measured D1 terminal calls. */
  durationMs(): number;
}

/** Stable value shape used by aggregate logs and performance assertions. */
export interface DbUsageMetrics {
  rowsRead: number;
  rowsWritten: number;
  statementCount: number;
  returnedRows: number;
  durationMs: number;
}

function count(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * Runs a single-row query through `all()` so its reads are visible to {@link accountReads}.
 *
 * `first()` is the natural call for a `COUNT(*)` or a lookup, and it is exactly the wrong one for
 * the statements worth measuring: an aggregate over an unindexed predicate returns one row and can
 * read the whole table, so the queries that dominate the read budget were the ones contributing
 * nothing to the total. `all()` carries the same `meta` every other statement does.
 *
 * The result shape is `first()`'s, so this is a drop-in at the call site. Use it for aggregates and
 * for lookups that already constrain themselves to one row; it does not add a `LIMIT`, because
 * silently bounding a caller's query would change what the measurement is measuring.
 */
export async function firstMeasured<T>(statement: D1PreparedStatement): Promise<T | null> {
  const result = await statement.all<T>();
  return result.results?.[0] ?? null;
}

/**
 * Wraps `db` so the rows its statements read are accumulated.
 *
 * The wrapper only intercepts the terminal calls that carry `meta` -- `all`, `run` and `batch` --
 * and delegates everything else untouched, so a caller cannot tell it is being measured.
 */
export function accountReads(db: QueryableDatabase): ReadAccounting<QueryableDatabase>;
export function accountReads(db: ReadableDatabase): ReadAccounting<ReadableDatabase>;
export function accountReads(db: ReadableDatabase): ReadAccounting<ReadableDatabase> {
  let rowsRead = 0;
  let rowsWritten = 0;
  let countedStatements = 0;
  let statementCount = 0;
  let returnedRows = 0;
  let durationMs = 0;

  const record = (result: unknown): void => {
    const results = (result as { results?: unknown[] | null } | null)?.results;
    if (Array.isArray(results)) returnedRows += results.length;
    const meta = (result as CountedResult | null)?.meta;
    if (!meta) return;
    countedStatements += 1;
    rowsRead += count(meta.rows_read);
    rowsWritten += count(meta.rows_written);
  };

  // `batch` executes its statements itself rather than calling their terminal methods, so a wrapped
  // statement handed to it must be unwrapped first: counting the batch result and the statement
  // would report the same rows twice.
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();

  // The statement surface is wider than the repositories use, so delegation is by property rather
  // than by reimplementation: only the terminal calls that carry `meta` are replaced.
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      ...statement,
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: (column?: string) =>
        column === undefined ? statement.first() : statement.first(column),
      raw: (options?: unknown) => (statement.raw as (options?: unknown) => unknown)(options),
      all: async () => {
        statementCount += 1;
        const startedAt = performance.now();
        try {
          const result = await statement.all();
          record(result);
          return result;
        } finally {
          durationMs += performance.now() - startedAt;
        }
      },
      run: async () => {
        statementCount += 1;
        const startedAt = performance.now();
        try {
          const result = await statement.run();
          record(result);
          return result;
        } finally {
          durationMs += performance.now() - startedAt;
        }
      },
    } as unknown as D1PreparedStatement;
    originals.set(wrapped, statement);
    return wrapped;
  };

  const batch = (db as Partial<QueryableDatabase>).batch;
  const measuredDb = {
    prepare: (query: string) => wrap(db.prepare(query)),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (typeof batch !== "function") {
        throw new Error("batch() is unavailable on this read-only database");
      }
      statementCount += statements.length;
      const startedAt = performance.now();
      try {
        const results = (await batch.call(
          db,
          statements.map((statement) => originals.get(statement) ?? statement),
        )) as D1Result<T>[];
        for (const result of results) record(result);
        return results;
      } finally {
        durationMs += performance.now() - startedAt;
      }
    },
  } as QueryableDatabase;

  return {
    // Overloads expose only the surface the input had. The runtime wrapper has `batch` as well so
    // a QueryableDatabase keeps its exact behaviour, while a read-only caller cannot access it.
    db: measuredDb,
    rowsRead: () => rowsRead,
    rowsWritten: () => rowsWritten,
    countedStatements: () => countedStatements,
    statementCount: () => statementCount,
    returnedRows: () => returnedRows,
    durationMs: () => durationMs,
  };
}

/** Takes one immutable snapshot so callers cannot accidentally mix points in time. */
export function dbUsageMetrics(accounting: ReadAccounting<ReadableDatabase>): DbUsageMetrics {
  return {
    rowsRead: accounting.rowsRead(),
    rowsWritten: accounting.rowsWritten(),
    statementCount: accounting.statementCount(),
    returnedRows: accounting.returnedRows(),
    durationMs: accounting.durationMs(),
  };
}

/** Combines independently measured query groups into one aggregate without losing statement cost. */
export function sumDbUsageMetrics(...metrics: readonly DbUsageMetrics[]): DbUsageMetrics {
  return metrics.reduce<DbUsageMetrics>(
    (total, current) => ({
      rowsRead: total.rowsRead + current.rowsRead,
      rowsWritten: total.rowsWritten + current.rowsWritten,
      statementCount: total.statementCount + current.statementCount,
      returnedRows: total.returnedRows + current.returnedRows,
      durationMs: total.durationMs + current.durationMs,
    }),
    { rowsRead: 0, rowsWritten: 0, statementCount: 0, returnedRows: 0, durationMs: 0 },
  );
}
