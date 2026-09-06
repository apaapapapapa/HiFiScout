import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../src/types.js";
import { migrationQuery, workingMigrations } from "./lib/migration-history.js";
import type { MigrationSource } from "./lib/migration-history.js";

type Execute = (input: { command: string } | { file: string }) => Promise<unknown>;

function results(response: unknown): Record<string, unknown>[] {
  if (!Array.isArray(response) || response.length === 0) {
    throw new Error("Wrangler returned no D1 result envelopes");
  }
  return response.flatMap((envelope) => {
    if (
      !isRecord(envelope) ||
      envelope.success !== true ||
      !Array.isArray(envelope.results) ||
      !envelope.results.every(isRecord)
    ) {
      throw new Error("Wrangler returned an invalid or unsuccessful D1 result");
    }
    return envelope.results;
  });
}

/** The /import endpoint parses complete SQL files, including CASE/END inside triggers.
 * One import contains one migration plus its history row; a failed import rolls both back.
 * Never substitute --command here: remote /query has different compound-statement parsing.
 */
export async function applyRemoteMigrations(
  migrations: readonly MigrationSource[],
  execute: Execute,
  log: (message: string) => void = console.log,
): Promise<void> {
  const applied = new Set(
    results(
      await execute({
        command:
          "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); SELECT name FROM d1_migrations ORDER BY id;",
      }),
    ).map((row) => {
      if (typeof row.name !== "string") throw new Error("Invalid D1 migration history row");
      return row.name;
    }),
  );
  const names = new Set(migrations.map(({ name }) => name));
  for (const name of applied) {
    if (!names.has(name)) throw new Error(`Remote migration is absent from this checkout: ${name}`);
  }
  const pending = migrations.filter(({ name }) => !applied.has(name));
  if (!pending.length) {
    log("No D1 migrations to apply.");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "hifiscout-d1-migrations-"));
  try {
    for (const migration of pending) {
      const file = join(directory, "migration.sql");
      writeFileSync(file, migrationQuery(migration));
      log(`Applying ${migration.name} through D1 SQL import.`);
      results(await execute({ file }));
      log(`Applied ${migration.name}.`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("apply-remote-migrations.ts")) {
  const root = process.cwd();
  try {
    await applyRemoteMigrations(workingMigrations(root), async (input) => {
      const result = spawnSync(
        process.execPath,
        [
          join(root, "node_modules/wrangler/bin/wrangler.js"),
          "d1",
          "execute",
          "DB",
          "--remote",
          "--json",
          "--yes",
          ...("file" in input ? ["--file", input.file] : ["--command", input.command]),
        ],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) {
        // Preserve Wrangler's diagnostic codes for the deployment's quota/CPU retry handling.
        throw new Error(`${result.stdout}\n${result.stderr}`.trim());
      }
      return JSON.parse(result.stdout) as unknown;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
