import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { QueryableDatabase } from "../../src/db/types.js";
import type { MigrationSource } from "../../scripts/lib/migration-history.js";
import { asQueryableDatabase } from "./d1.js";

/** Disposable workerd D1; never connects to a Cloudflare account or production data. */
export async function localD1() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('migration test'); } }",
      compatibilityDate: "2026-01-01",
      d1Databases: ["DB"],
    }),
  );
  try {
    const db = asQueryableDatabase(await mf.getD1Database("DB"));
    await db
      .prepare(
        "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)",
      )
      .run();
    return { db, dispose: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

/** Mirror Wrangler's per-file atomic boundary, including its filename history record. */
export async function applyMigration(
  db: QueryableDatabase,
  migration: MigrationSource,
): Promise<void> {
  const sql = migration.sql.replace(/^\s*--[^\n]*$/gm, "").trim();
  const statements = sql ? [db.prepare(sql)] : [];
  await db.batch([
    ...statements,
    db.prepare("INSERT INTO d1_migrations(name) VALUES (?)").bind(migration.name),
  ]);
}
