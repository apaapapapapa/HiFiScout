import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [stateDir] = process.argv.slice(2);
if (!stateDir) {
  console.error("Usage: npx tsx scripts/docs/find-d1-database.ts <wrangler-state-dir>");
  process.exit(2);
}

function findSqliteFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findSqliteFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".sqlite")) {
      files.push(path);
    }
  }
  return files;
}

const requiredTables = new Set(["products", "price_history", "shop_sync_state", "crawl_runs"]);
const matches: string[] = [];
const candidates = findSqliteFiles(stateDir);

for (const path of candidates) {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const rows = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
    const tableNames = new Set(rows.map(({ name }) => name));
    if ([...requiredTables].every((name) => tableNames.has(name))) {
      matches.push(path);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Skipping unreadable SQLite candidate ${path}: ${message}`);
  } finally {
    database?.close();
  }
}

if (matches.length !== 1) {
  console.error(
    `Expected exactly one migrated HiFiScout D1 database under ${stateDir}, found ${matches.length}. ` +
      `SQLite candidates: ${candidates.join(", ") || "(none)"}`,
  );
  process.exit(1);
}

// Wrangler's local D1 database uses WAL journaling. Flush committed migration
// pages into the database file before the SchemaSpy script copies that file.
const migratedDatabase = new DatabaseSync(matches[0]);
try {
  migratedDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
} finally {
  migratedDatabase.close();
}

console.log(matches[0]);
