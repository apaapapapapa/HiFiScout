import { DatabaseSync } from "node:sqlite";
import type { QueryableDatabase } from "../../src/db/types.js";
import { sqliteD1 } from "./sqlite-d1.js";
import { migrationSources } from "./migrations.js";

/**
 * An in-memory database carrying the *production* schema, built by replaying `migrations/`.
 *
 * The hand-written DDL used elsewhere in `test/` is right for a repository that touches three
 * columns, but it cannot prove anything about the parts of the search read model that live in the
 * schema itself: the FTS5 index, the trigger that maintains it, the `entity_kind` CHECK that makes
 * a half-catalog/half-fallback entity unrepresentable, and the membership primary key that makes
 * duplicate membership impossible rather than merely unlikely. Replaying the real migrations is
 * also the only way a test can fail when a *future* migration breaks one of those invariants.
 *
 * Node's bundled SQLite builds FTS5 in, so this runs in the fast unit suite with no Wrangler and no
 * network. `scripts/verify-search-integration.ts` still exercises the same statements against a
 * migrated D1 in CI; that check owns the Wrangler/D1 boundary, this one owns the behaviour.
 */

export interface MigratedDatabase {
  /** Direct handle, for arranging fixtures and asserting on stored rows. */
  readonly sqlite: DatabaseSync;
  /** The same database behind the `QueryableDatabase` boundary repositories are written against. */
  readonly db: QueryableDatabase;
}

/**
 * Applies migrations in order to a fresh in-memory database, optionally stopping before a name.
 *
 * SQL is read once per test module and applied per call, so each test gets an isolated database
 * without re-reading the files. Historical migration tests can arrange data before an upgrade.
 */
export function migratedSqlite({ before }: { before?: string } = {}): MigratedDatabase {
  const end =
    before === undefined
      ? migrationSources.length
      : migrationSources.findIndex((file) => file.name === before);
  if (end < 0) throw new Error(`Unknown migration: ${before}`);
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (const { sql } of migrationSources.slice(0, end)) sqlite.exec(sql);
    return { sqlite, db: sqliteD1(sqlite) };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
