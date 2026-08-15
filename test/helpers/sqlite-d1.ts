import { type DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { QueryableDatabase } from "../../src/db/types.js";
import { asQueryableDatabase } from "./d1.js";

interface SqlitePreparedStatement {
  readonly sql: string;
  readonly binds: SQLInputValue[];
  bind(...binds: SQLInputValue[]): SqlitePreparedStatement;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }>;
}

/**
 * Minimal D1 adapter over Node's synchronous SQLite used for repository state-transition tests.
 * It intentionally implements only the `prepare`/`batch` boundary production repositories use.
 */
export function sqliteD1(database: DatabaseSync): QueryableDatabase {
  const prepare = (sql: string): SqlitePreparedStatement => {
    const bound = (binds: SQLInputValue[]): SqlitePreparedStatement => ({
      sql,
      binds,
      bind: (...next) => bound(next),
      async all<T>() {
        return { results: database.prepare(sql).all(...binds) as T[] };
      },
      async first<T>() {
        return (database.prepare(sql).get(...binds) as T | undefined) ?? null;
      },
      async run() {
        const result = database.prepare(sql).run(...binds);
        return {
          success: true,
          meta: {
            changes: Number(result.changes),
            last_row_id: Number(result.lastInsertRowid),
          },
        };
      },
    });
    return bound([]);
  };

  return asQueryableDatabase({
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements as unknown as SqlitePreparedStatement[]) {
          results.push(await statement.run());
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  });
}
