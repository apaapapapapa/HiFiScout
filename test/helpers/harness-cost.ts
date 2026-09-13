import type { QueryableDatabase } from "../../src/db/types.js";

/** Strict D1 boundary measurement. Missing meta and first/raw/failure leave row totals unknown. */
export function measureD1Cost(db: QueryableDatabase) {
  let statements = 0;
  let reads: number | null = 0,
    writes: number | null = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const add = (total: number | null, value: unknown) =>
    total !== null && typeof value === "number" && Number.isFinite(value) && value >= 0
      ? total + value
      : null;
  const record = (value: unknown) => {
    const meta = (value as { meta?: { rows_read?: unknown; rows_written?: unknown } } | null)?.meta;
    reads = add(reads, meta?.rows_read);
    writes = add(writes, meta?.rows_written);
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (["all", "run", "first", "raw"].includes(String(key)))
          return async (...args: unknown[]) => {
            statements++;
            try {
              const result: unknown = await Reflect.apply(Reflect.get(target, key), target, args);
              record(key === "first" || key === "raw" ? null : result);
              return result;
            } catch (error) {
              record(null);
              throw error;
            }
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  const measured: QueryableDatabase = {
    ...db,
    prepare: (query) => wrap(db.prepare(query)),
    batch: async <T>(batch: D1PreparedStatement[]) => {
      statements += batch.length;
      try {
        const results = await db.batch<T>(
          batch.map((statement) => originals.get(statement) ?? statement),
        );
        for (const result of results) record(result);
        if (results.length !== batch.length) record(null);
        return results;
      } catch (error) {
        record(null);
        throw error;
      }
    },
  };
  return {
    db: measured,
    metrics: () => ({
      rowsRead: statements ? reads : null,
      rowsWritten: statements ? writes : null,
      sqlStatements: statements,
    }),
  };
}
