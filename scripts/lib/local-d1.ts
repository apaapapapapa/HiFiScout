import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/types.js";

export type D1Row = Record<string, unknown>;

/**
 * Execute a SQL batch against Wrangler's local D1 database with a single CLI process.
 *
 * Integration checks intentionally use the real Wrangler/D1 path rather than a SQLite mock, but
 * starting Wrangler for every statement dominates their runtime. A file may contain many SQL
 * statements; Wrangler returns one or more result envelopes, which are flattened here so callers
 * can tag assertion SELECTs with a marker column and inspect them after one execution.
 */
export function executeLocalD1(sql: string): D1Row[] {
  const directory = mkdtempSync(join(tmpdir(), "hifiscout-local-d1-"));
  const statementFile = join(directory, "statements.sql");
  writeFileSync(statementFile, sql, "utf8");

  const wrangler = join(
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );

  try {
    const output = execFileSync(
      wrangler,
      ["d1", "execute", "DB", "--local", "--json", `--file=${statementFile}`],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        shell: process.platform === "win32",
      },
    );

    const jsonStart = output.indexOf("[");
    if (jsonStart < 0) {
      throw new Error(`Wrangler D1 output did not contain JSON: ${output}`);
    }

    const parsed: unknown = JSON.parse(output.slice(jsonStart));
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((result) =>
      isRecord(result) && Array.isArray(result.results)
        ? (result.results.filter(isRecord) as D1Row[])
        : [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function rowsFor(rows: D1Row[], check: string): D1Row[] {
  return rows.filter((row) => row.check_name === check);
}

export function numberFrom(rows: D1Row[], column: string): number {
  return Number(rows[0]?.[column] ?? -1);
}
