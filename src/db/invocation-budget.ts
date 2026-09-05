import type { QueryableDatabase } from "./types.js";

export const D1_WORK_UNIT = Symbol("d1WorkUnit");

type BudgetedDatabase = QueryableDatabase & {
  [D1_WORK_UNIT]?: <T>(calls: number, work: () => Promise<T>) => Promise<T>;
};

/** Admit a complete projection transition before its first write, never halfway through it. */
export function withinD1Budget<T>(
  db: QueryableDatabase,
  calls: number,
  work: () => Promise<T>,
): Promise<T> {
  return (db as BudgetedDatabase)[D1_WORK_UNIT]?.(calls, work) ?? work();
}

/** A cooperative yield, not a failed data repair. Durable claims/checkpoints remain retryable. */
export class InvocationBudgetExceeded extends Error {
  constructor(readonly reason: "d1_calls" | "wall_time") {
    super(`Scheduled invocation budget exhausted: ${reason}`);
    this.name = "InvocationBudgetExceeded";
  }
}

export interface InvocationBudget {
  db: QueryableDatabase;
  remainingCalls(): number;
  exhausted(): boolean;
  /** Record a cooperative yield when the remaining calls cannot fit the next useful unit. */
  defer(): void;
  metrics(): {
    d1Calls: number;
    sqlStatements: number;
    elapsedMs: number;
    yieldReason: string | null;
  };
}

/** One budget must wrap the entire invocation, including watchdogs, task bookkeeping, first/raw
 * and failed calls. A D1 batch is one binding round trip; its SQL statements are reported
 * separately and are never split, preserving the transaction boundary.
 * Wall time bounds continuations; it is explicitly NOT a measurement of Workers CPU time.
 */
export function invocationBudget(
  inner: QueryableDatabase,
  { maxCalls = 45, maxWallMs = 20_000, clock = () => performance.now() } = {},
): InvocationBudget {
  const started = clock();
  let calls = 0;
  let statements = 0;
  let yieldReason: "d1_calls" | "wall_time" | null = null;
  let workUnitDepth = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const admit = (statementCount: number) => {
    if (calls >= maxCalls) yieldReason = "d1_calls";
    else if (!workUnitDepth && clock() - started >= maxWallMs) yieldReason = "wall_time";
    if (yieldReason) throw new InvocationBudgetExceeded(yieldReason);
    calls += 1;
    statements += statementCount;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      async all() {
        admit(1);
        return statement.all();
      },
      async run() {
        admit(1);
        return statement.run();
      },
      async first(column?: string) {
        admit(1);
        return column === undefined ? statement.first() : statement.first(column);
      },
      async raw(options?: { columnNames?: boolean }) {
        admit(1);
        return options?.columnNames
          ? statement.raw({ columnNames: true })
          : statement.raw({ columnNames: false });
      },
    } as D1PreparedStatement;
    originals.set(wrapped, statement);
    return wrapped;
  };
  return {
    db: {
      async [D1_WORK_UNIT]<T>(requiredCalls: number, work: () => Promise<T>): Promise<T> {
        if (requiredCalls > maxCalls - calls) yieldReason = "d1_calls";
        else if (!workUnitDepth && clock() - started >= maxWallMs) yieldReason = "wall_time";
        if (yieldReason) throw new InvocationBudgetExceeded(yieldReason);
        workUnitDepth += 1;
        try {
          return await work();
        } finally {
          workUnitDepth -= 1;
        }
      },
      prepare: (sql: string) => wrap(inner.prepare(sql)),
      async batch<T>(batch: D1PreparedStatement[]) {
        admit(batch.length);
        return inner.batch<T>(batch.map((statement) => originals.get(statement) || statement));
      },
    } as BudgetedDatabase,
    remainingCalls: () => Math.max(0, maxCalls - calls),
    exhausted: () => yieldReason !== null || calls >= maxCalls || clock() - started >= maxWallMs,
    defer: () => {
      yieldReason ||= "d1_calls";
    },
    metrics: () => ({
      d1Calls: calls,
      sqlStatements: statements,
      elapsedMs: clock() - started,
      yieldReason,
    }),
  };
}
