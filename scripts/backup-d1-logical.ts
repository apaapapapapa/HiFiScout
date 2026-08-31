import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { QueryableDatabase } from "../src/db/types.js";
import { createD1RestDatabase } from "./lib/d1-rest-database.js";

interface TableListRow {
  schema: string;
  name: string;
  type: string;
  wr: number;
}

interface TableColumnRow {
  name: string;
  hidden: number;
  pk: number;
}

interface DumpRow {
  statement: string;
  __cursor?: string;
  [key: string]: unknown;
}

export interface BackupTable {
  name: string;
  withoutRowid: boolean;
}

const DEFAULT_BATCH_SIZE = 500;
const INTERNAL_TABLE_NAMES = new Set(["d1_migrations"]);

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function selectBackupTables(rows: readonly TableListRow[]): BackupTable[] {
  return rows
    .filter(
      (row) =>
        row.schema === "main" &&
        row.type === "table" &&
        !row.name.startsWith("sqlite_") &&
        !row.name.startsWith("_cf_") &&
        !INTERNAL_TABLE_NAMES.has(row.name),
    )
    .map((row) => ({ name: row.name, withoutRowid: row.wr === 1 }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function writableColumns(rows: readonly TableColumnRow[]): TableColumnRow[] {
  return rows.filter((row) => row.hidden === 0);
}

function insertStatementExpression(table: string, columns: readonly TableColumnRow[]): string {
  const quotedTable = quoteIdentifier(table);
  const columnList = columns.map((column) => quoteIdentifier(column.name)).join(", ");
  const values = columns
    .map((column) => `quote(${quoteIdentifier(column.name)})`)
    .join(` || ', ' || `);
  return `'INSERT OR REPLACE INTO ${quotedTable} (${columnList}) VALUES (' || ${values} || ');'`;
}

export function buildRowidDumpQuery(
  table: string,
  columns: readonly TableColumnRow[],
  upperRowid: string,
  afterRowid: string | null,
  limit: number,
): string {
  const quotedTable = quoteIdentifier(table);
  const cursorPredicate = afterRowid == null ? "" : ` AND rowid > ${afterRowid}`;
  return `SELECT ${insertStatementExpression(table, columns)} AS statement, CAST(rowid AS TEXT) AS __cursor FROM ${quotedTable} WHERE rowid <= ${upperRowid}${cursorPredicate} ORDER BY rowid LIMIT ${limit}`;
}

function keysetAfterPredicate(
  primaryKeyColumns: readonly TableColumnRow[],
  cursorLiterals: readonly string[],
): string {
  return primaryKeyColumns
    .map((column, index) => {
      const equals = primaryKeyColumns
        .slice(0, index)
        .map(
          (previousColumn, previousIndex) =>
            `${quoteIdentifier(previousColumn.name)} = ${cursorLiterals[previousIndex]}`,
        )
        .join(" AND ");
      const greater = `${quoteIdentifier(column.name)} > ${cursorLiterals[index]}`;
      return equals ? `(${equals} AND ${greater})` : `(${greater})`;
    })
    .join(" OR ");
}

export function buildWithoutRowidDumpQuery(
  table: string,
  columns: readonly TableColumnRow[],
  primaryKeyColumns: readonly TableColumnRow[],
  cursorLiterals: readonly string[] | null,
  limit: number,
): string {
  if (!primaryKeyColumns.length) {
    throw new Error(`WITHOUT ROWID table ${table} has no primary key`);
  }
  const quotedTable = quoteIdentifier(table);
  const cursorColumns = primaryKeyColumns
    .map((column, index) => `quote(${quoteIdentifier(column.name)}) AS __pk${index}`)
    .join(", ");
  const where =
    cursorLiterals == null ? "" : ` WHERE ${keysetAfterPredicate(primaryKeyColumns, cursorLiterals)}`;
  const orderBy = primaryKeyColumns.map((column) => quoteIdentifier(column.name)).join(", ");
  return `SELECT ${insertStatementExpression(table, columns)} AS statement, ${cursorColumns} FROM ${quotedTable}${where} ORDER BY ${orderBy} LIMIT ${limit}`;
}

function assertIntegerLiteral(value: unknown, context: string): string {
  const text = String(value ?? "");
  if (!/^-?\d+$/u.test(text)) throw new Error(`${context} is not an integer literal: ${text}`);
  return text;
}

async function tableColumns(db: QueryableDatabase, table: string): Promise<TableColumnRow[]> {
  const result = await db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all<TableColumnRow>();
  return result.results || [];
}

async function appendRows(path: string, rows: readonly DumpRow[]): Promise<void> {
  if (!rows.length) return;
  await appendFile(path, `${rows.map((row) => row.statement).join("\n")}\n`, "utf8");
}

async function dumpRowidTable(
  db: QueryableDatabase,
  path: string,
  table: BackupTable,
  columns: readonly TableColumnRow[],
  batchSize: number,
): Promise<number> {
  const quotedTable = quoteIdentifier(table.name);
  const boundary = await db
    .prepare(`SELECT CAST(MAX(rowid) AS TEXT) AS max_rowid FROM ${quotedTable}`)
    .first<{ max_rowid: string | null }>();
  if (!boundary?.max_rowid) return 0;
  const upperRowid = assertIntegerLiteral(boundary.max_rowid, `${table.name} max rowid`);
  let afterRowid: string | null = null;
  let total = 0;

  for (;;) {
    const query = buildRowidDumpQuery(table.name, columns, upperRowid, afterRowid, batchSize);
    const result = await db.prepare(query).all<DumpRow>();
    const rows = result.results || [];
    await appendRows(path, rows);
    total += rows.length;
    if (rows.length < batchSize) break;
    const nextCursor = rows.at(-1)?.__cursor;
    afterRowid = assertIntegerLiteral(nextCursor, `${table.name} rowid cursor`);
  }
  return total;
}

async function dumpWithoutRowidTable(
  db: QueryableDatabase,
  path: string,
  table: BackupTable,
  columns: readonly TableColumnRow[],
  batchSize: number,
): Promise<number> {
  const primaryKeyColumns = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
  let cursorLiterals: string[] | null = null;
  let total = 0;

  for (;;) {
    const query = buildWithoutRowidDumpQuery(
      table.name,
      columns,
      primaryKeyColumns,
      cursorLiterals,
      batchSize,
    );
    const result = await db.prepare(query).all<DumpRow>();
    const rows = result.results || [];
    await appendRows(path, rows);
    total += rows.length;
    if (rows.length < batchSize) break;
    const last = rows.at(-1);
    cursorLiterals = primaryKeyColumns.map((_, index) => {
      const value = last?.[`__pk${index}`];
      if (typeof value !== "string" || !value) {
        throw new Error(`${table.name} primary-key cursor ${index} was not returned by D1`);
      }
      return value;
    });
  }
  return total;
}

export async function exportLogicalD1Backup(
  db: QueryableDatabase,
  output: string,
  options: { batchSize?: number; sourceSha?: string; generatedAt?: string } = {},
): Promise<{ tableCount: number; rowCount: number }> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const sourceSha = options.sourceSha || "unknown";
  const tableRows = await db.prepare("PRAGMA table_list").all<TableListRow>();
  const tables = selectBackupTables(tableRows.results || []);

  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    [
      "-- HiFiScout D1 logical backup",
      `-- Generated at: ${generatedAt}`,
      `-- Source commit: ${sourceSha}`,
      "-- Restore contract: create an empty D1 database, apply the repository migrations at the source commit, then execute this file.",
      "-- FTS5 virtual tables and their shadow tables are intentionally excluded because Cloudflare D1 cannot export databases containing virtual tables; migrations recreate them.",
      "-- Cloudflare/SQLite internal tables and d1_migrations are also excluded because the target database owns its migration state.",
      "PRAGMA defer_foreign_keys = TRUE;",
      "",
    ].join("\n"),
    "utf8",
  );

  let rowCount = 0;
  for (const table of tables) {
    const columns = writableColumns(await tableColumns(db, table.name));
    if (!columns.length) continue;
    await appendFile(output, `-- table: ${quoteIdentifier(table.name)}\n`, "utf8");
    const dumped = table.withoutRowid
      ? await dumpWithoutRowidTable(db, output, table, columns, batchSize)
      : await dumpRowidTable(db, output, table, columns, batchSize);
    rowCount += dumped;
    console.log(`Backed up ${table.name}: ${dumped} rows`);
  }

  await appendFile(
    output,
    `\n-- Backup complete: ${tables.length} tables, ${rowCount} rows\n`,
    "utf8",
  );
  return { tableCount: tables.length, rowCount };
}

async function main(): Promise<void> {
  const output = argument("--output", ".generated/hifiscout-d1-logical-backup.sql");
  const batchSize = positiveInteger(argument("--batch-size", String(DEFAULT_BATCH_SIZE)), "--batch-size");
  const db = createD1RestDatabase({
    accountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
    databaseId: requiredEnv("D1_DATABASE_ID"),
    apiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
  });
  const result = await exportLogicalD1Backup(db, output, {
    batchSize,
    sourceSha: process.env.GITHUB_SHA,
  });
  console.log(`Logical D1 backup written to ${output}: ${result.tableCount} tables, ${result.rowCount} rows`);
}

if (process.argv[1]?.endsWith("backup-d1-logical.ts")) {
  await main();
}
