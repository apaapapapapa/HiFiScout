import type { QueryableDatabase } from "../../src/db/types.js";
import type { EvidenceDatabase } from "../../src/evidence/evidence-archive.js";

/**
 * Adapts deliberately small, behavior-focused D1 fakes to the repository boundary.
 * The assertion stays in one test-only location because Cloudflare's generic D1 methods cannot
 * be implemented structurally by fixtures that return a fixed row shape.
 */
export function asQueryableDatabase<T extends object>(database: T): T & QueryableDatabase {
  return database as T & QueryableDatabase;
}

export function asEvidenceDatabase<T extends object>(database: T): T & EvidenceDatabase {
  return database as T & EvidenceDatabase;
}

export interface CapturedStatement {
  sql: string;
  binds: unknown[];
}

/** Chooses the rows a statement resolves to, so one fake can serve count + page queries. */
export type StatementResults = (statement: CapturedStatement) => unknown[];

export interface CaptureDatabase extends QueryableDatabase {
  /** Every `prepare().bind()` call, in order. */
  readonly calls: CapturedStatement[];
  /** Every statement handed to `batch()`, flattened in call order. */
  readonly batched: CapturedStatement[];
}

/**
 * Statement-capture D1 double.
 *
 * Deliberately not a SQLite emulator: it records the SQL and binds a repository produced and
 * replays caller-chosen rows. Tests assert on those recordings, which is what repository SQL
 * shape tests actually need. `batch()` reports one changed row per statement.
 */
export function captureDatabase(results: unknown[] | StatementResults = []): CaptureDatabase {
  const calls: CapturedStatement[] = [];
  const batched: CapturedStatement[] = [];
  const select: StatementResults = typeof results === "function" ? results : () => results;
  return asQueryableDatabase({
    calls,
    batched,
    prepare(sql: string) {
      // D1 lets a parameterless statement skip `bind()`, so the double has to as well —
      // otherwise a repository that omits it fails here for a reason production would not.
      const record = (binds: unknown[]) => {
        const statement: CapturedStatement = { sql, binds };
        calls.push(statement);
        return {
          ...statement,
          async all() {
            return { results: select(statement) };
          },
          async first() {
            return select(statement)[0] ?? null;
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
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
    async batch(statements: CapturedStatement[]) {
      batched.push(...statements);
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  });
}
