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
 * reads cannot be counted without changing the call into `all()`. Totals are therefore a lower
 * bound, and the modules that own the heavy scans should prefer `all()` when they want to be
 * measurable.
 */

import type { QueryableDatabase } from "./types.js";

/** The subset of `meta` this cares about; absent fields simply do not contribute. */
interface CountedResult {
  meta?: { rows_read?: number | null; rows_written?: number | null } | null;
}

export interface ReadAccounting {
  /** Hand this to the work being measured; it behaves exactly like the database it wraps. */
  readonly db: QueryableDatabase;
  /** Rows D1 reported reading, across every counted statement so far. */
  rowsRead(): number;
  /** Rows D1 reported writing, across every counted statement so far. */
  rowsWritten(): number;
  /** How many statements reported a count, so a zero total can be told from no measurement. */
  countedStatements(): number;
}

function count(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * Wraps `db` so the rows its statements read are accumulated.
 *
 * The wrapper only intercepts the terminal calls that carry `meta` -- `all`, `run` and `batch` --
 * and delegates everything else untouched, so a caller cannot tell it is being measured.
 */
export function accountReads(db: QueryableDatabase): ReadAccounting {
  let rowsRead = 0;
  let rowsWritten = 0;
  let countedStatements = 0;

  const record = (result: unknown): void => {
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
        const result = await statement.all();
        record(result);
        return result;
      },
      run: async () => {
        const result = await statement.run();
        record(result);
        return result;
      },
    } as unknown as D1PreparedStatement;
    originals.set(wrapped, statement);
    return wrapped;
  };

  return {
    db: {
      prepare: (query: string) => wrap(db.prepare(query)),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        const results = await db.batch<T>(
          statements.map((statement) => originals.get(statement) ?? statement),
        );
        for (const result of results) record(result);
        return results;
      },
    } as QueryableDatabase,
    rowsRead: () => rowsRead,
    rowsWritten: () => rowsWritten,
    countedStatements: () => countedStatements,
  };
}
