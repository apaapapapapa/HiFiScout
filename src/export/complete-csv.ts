import type { ReadableDatabase } from "../db/types.js";

export type CompleteExportScope = "catalog" | "active" | "all";
export interface ExportTable {
  name: string;
  sql: string;
  maxRowid: string | null;
  key: string | string[];
}
export interface CompleteExportPlan {
  version: 1 | 2;
  scope: CompleteExportScope;
  capturedAt: string;
  tables: ExportTable[];
}
export interface CompleteExportCursor {
  table: number;
  after: string | null;
  evidence?: {
    rowid: string;
    sourceKey: string;
    offset: number;
    etag: string;
    totalBytes: number;
  };
}
interface Column {
  name: string;
  type: string;
  hidden: number;
  pk: number;
}

const PAGE_ROWS = 1_000;
const PAGE_SOURCE_BYTES = 2 * 1024 * 1024;
const ROWID = "_rowid_";

function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function keyNames(table: Pick<ExportTable, "key">): string[] {
  return typeof table.key === "string" ? [table.key] : table.key;
}

/** Keep integer keys as decimal strings, including values beyond JavaScript's safe range. */
function cursorExpression(keys: string[]): string {
  const values = keys.map((key) => `CAST(${identifier(key)} AS TEXT)`);
  return values.length === 1 ? values[0] : `json_array(${values.join(",")})`;
}

function cursorBindings(value: string | null, size: number): (string | null)[] {
  if (size === 1) return [value];
  if (value === null) return Array.from({ length: size }, () => null);
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== size ||
    !parsed.every((key) => typeof key === "string")
  )
    throw new Error("complete_export_invalid_composite_cursor");
  return parsed;
}

/** All persisted product/catalog families, including histories and manual authority. FTS shadow
 * tables are physical indexes of exported projections, not additional product information. */
export function isCompleteExportTable(name: string): boolean {
  return (
    !name.includes("_fts") &&
    !name.endsWith("_export_jobs") &&
    (/^(?:products$|product_|knowledge_catalog_|data_quality_remediation_)/u.test(name) ||
      [
        "catalog_product_specifications",
        "price_history",
        "evidence_archive",
        "listing_projection_pending",
        "taxonomy_v3_migration_audit",
        "admin_csv_import_changes",
      ].includes(name))
  );
}

export async function createCompleteExportPlan(
  db: ReadableDatabase,
  scope: CompleteExportScope,
  maxPrimaryId: number,
): Promise<CompleteExportPlan> {
  const result = await db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string; sql: string }>();
  const tables = result.results
    .filter((row) => isCompleteExportTable(row.name))
    .map((row): Omit<ExportTable, "maxRowid"> => ({ ...row, key: ROWID }));
  const primary = scope === "catalog" ? "knowledge_catalog_products" : "products";
  tables.sort(
    (a, b) =>
      Number(b.name === primary) - Number(a.name === primary) || a.name.localeCompare(b.name),
  );
  if (!tables.some((row) => row.name === primary))
    throw new Error("complete_export_primary_table_missing");
  for (const table of tables) {
    if (!/^[a-zA-Z0-9_]+$/u.test(table.name) || /\bVIRTUAL\s+TABLE\b/iu.test(table.sql)) {
      throw new Error(`complete_export_unsupported_table:${table.name}`);
    }
    if (/\bWITHOUT\s+ROWID\b/iu.test(table.sql)) {
      const columns = await db
        .prepare(`PRAGMA table_xinfo(${identifier(table.name)})`)
        .all<Column>();
      const keys = columns.results.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
      if (
        !keys.length ||
        (keys.length > 1 && keys.some((column) => !/^(?:INTEGER|TEXT)$/iu.test(column.type)))
      )
        throw new Error(`complete_export_unsupported_cursor_type:${table.name}`);
      table.key = keys.length === 1 ? keys[0].name : keys.map((column) => column.name);
    }
  }
  // Each endpoint is a reverse primary-key seek, including a composite key. D1 allows at most
  // five compound SELECT terms. Horizons remain fixed per table, not a database-wide snapshot.
  const horizons: (string | null)[] = [];
  for (let start = 0; start < tables.length; start += 5) {
    const result = await db
      .prepare(
        tables
          .slice(start, start + 5)
          .map((table) => {
            const keys = keyNames(table);
            return `SELECT (SELECT ${cursorExpression(keys)} FROM ${identifier(table.name)}
        ORDER BY ${keys.map((key) => `${identifier(key)} DESC`).join(",")} LIMIT 1) AS maximum`;
          })
          .join(" UNION ALL "),
      )
      .all<{ maximum: string | null }>();
    horizons.push(...result.results.map((row) => row.maximum));
  }
  return {
    version: tables.some((table) => Array.isArray(table.key)) ? 2 : 1,
    scope,
    capturedAt: new Date().toISOString(),
    tables: tables.map((table, index) => ({
      ...table,
      maxRowid: table.name === primary ? String(maxPrimaryId) : horizons[index],
    })),
  };
}

/** A reversible spreadsheet-safe text encoding: escape backslashes/NULs, then guard formula
 * prefixes AND literal leading apostrophes. Numeric values retain their original SQL type. */
export function completeCsvCell(value: string | null, type = "text"): string {
  if (value === null) return "\\N";
  let encoded = value.replaceAll("\\", "\\\\").replaceAll("\0", "\\0");
  if (type === "text" && (/^[\s]*[=+\-@]/u.test(encoded) || /^[\t\r\n']/u.test(encoded))) {
    encoded = `'${encoded}`;
  }
  return `"${encoded.replaceAll('"', '""')}"`;
}

function sqlValue(value: unknown, type: string): string | null {
  if (value === null || typeof value === "string") return value;
  const bytes =
    value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : Array.isArray(value) &&
            value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
          ? Uint8Array.from(value)
          : null;
  if (!bytes) throw new Error("complete_export_unexpected_sql_value");
  if (type === "t") return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const digits = "0123456789ABCDEF";
  const hex = new Uint8Array(bytes.length * 2);
  for (let index = 0; index < bytes.length; index += 1) {
    hex[index * 2] = digits.charCodeAt(bytes[index] >>> 4);
    hex[index * 2 + 1] = digits.charCodeAt(bytes[index] & 15);
  }
  return new TextDecoder().decode(hex);
}

export const COMPLETE_CSV_ENCODING = {
  charset: "UTF-8 with BOM; RFC 4180 quoting; CRLF record endings",
  columns:
    "Each CSV contains every table column in schema order, followed by one SQLite type column. Every part repeats its header.",
  types:
    "The final column contains one tag per database column: t=text, i=integer, r=real, b=blob, n=null. Its name has underscores appended if it conflicts with a database column.",
  null: "SQL NULL is \\N. Empty text is an empty quoted field. Use the type tags to distinguish values.",
  text: "After CSV parsing, remove exactly one leading apostrophe from text cells if present, then decode \\\\ to a single backslash and \\0 to NUL in one left-to-right pass. Other characters, including newlines, are unchanged.",
  numbers:
    "Integers are decimal strings without JavaScript numeric conversion; reals use SQLite's round-trip decimal representation. Import numeric-looking text as text.",
  blobs: "BLOB values are uppercase hexadecimal, including empty blobs.",
  externalEvidence:
    "Retained R2 evidence is copied to evidence-<rowid>/part-<byte-offset>.bin without truncation. Concatenate parts by byte offset to restore an object. Per-file evidence metadata is in this manifest. Missing/expired objects have explicit unavailable.json records; external seller pages are not fetched.",
  consistency:
    "This is a live paginated export, not a point-in-time database backup. Primary-key/rowid horizons are fixed at plan creation; updates/deletes during generation can be reflected. Schema changes require regeneration. Regenerate after writes settle for a stable audit.",
};

export async function readCompleteExportPage(
  db: ReadableDatabase,
  plan: CompleteExportPlan,
  cursor: CompleteExportCursor,
): Promise<{ bytes: Uint8Array; filename: string; rows: number; next: CompleteExportCursor }> {
  const table = plan.tables[cursor.table];
  if (!table || !isCompleteExportTable(table.name))
    throw new Error("complete_export_invalid_cursor");
  const tableName = identifier(table.name);
  const keys = keyNames(table);
  const fields = keys.map(identifier);
  const key = fields.length === 1 ? fields[0] : `(${fields.join(",")})`;
  const parameter = fields.length === 1 ? "?" : `(${fields.map(() => "?").join(",")})`;
  const order = fields.join(",");
  const aliases = fields.map((_, index) => `k${index}`);
  const current = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(table.name)
    .first<{ sql: string }>();
  if (current?.sql !== table.sql) throw new Error(`complete_export_schema_changed:${table.name}`);
  const schema = await db.prepare(`PRAGMA table_xinfo(${tableName})`).all<Column>();
  const columns = schema.results.filter((column) => column.hidden !== 1);
  if (
    !columns.length ||
    (table.key === ROWID && columns.some((column) => column.name.toLowerCase() === ROWID))
  ) {
    throw new Error(`complete_export_unsupported_columns:${table.name}`);
  }
  const afterClause = cursor.after === null ? "" : ` AND ${key} > ${parameter}`;
  const activeClause =
    plan.scope === "active" && table.name === "products" ? " AND is_active = 1" : "";
  const where = `${key} <= ${parameter}${afterClause}${activeClause}`;
  const bindings = [
    ...cursorBindings(table.maxRowid, fields.length),
    ...(cursor.after === null ? [] : cursorBindings(cursor.after, fields.length)),
  ];
  const sizeExpression = columns
    .map((column) => `COALESCE(length(CAST(${identifier(column.name)} AS BLOB)), 0)`)
    .join(" + ");
  const projection = columns.map((column, index) => {
    const field = identifier(column.name);
    return `CASE typeof(${field}) WHEN 'integer' THEN CAST(${field} AS TEXT)
      WHEN 'text' THEN CAST(${field} AS BLOB)
      WHEN 'real' THEN printf('%!.17g', ${field}) ELSE ${field} END AS v${index}`;
  });
  projection.push(
    columns.map((column) => `substr(typeof(${identifier(column.name)}), 1, 1)`).join(" || ") +
      " AS types",
  );
  // The key/byte budget and row read share one SQL snapshot. Even a concurrent large update cannot
  // turn a previously sized page into an unbounded response. BLOBs stay binary at the D1 boundary:
  // hex() in SQL could exceed D1's per-value limit before JavaScript receives the original blob.
  // Text also crosses as UTF-8 bytes: SQLite adapters can otherwise truncate strings at NUL.
  const rows = (
    await db
      .prepare(`WITH candidates AS MATERIALIZED (
      SELECT ${fields.map((field, index) => `${field} AS ${aliases[index]}`).join(",")}, ${sizeExpression} + ${columns.length * 16} AS bytes
      FROM ${tableName} WHERE ${where} ORDER BY ${order} LIMIT ${PAGE_ROWS + 1}
    ), sized AS (
      SELECT ${aliases.join(",")}, SUM(bytes) OVER (ORDER BY ${aliases.join(",")}) AS total,
        ROW_NUMBER() OVER (ORDER BY ${aliases.join(",")}) AS position FROM candidates
    ), selected AS MATERIALIZED (
      SELECT ${aliases.join(",")} FROM sized WHERE position = 1 OR (position <= ${PAGE_ROWS} AND total <= ${PAGE_SOURCE_BYTES})
    )
    SELECT ${projection.join(",")}, ${cursorExpression(keys)} AS row_cursor,
      ((SELECT COUNT(*) FROM candidates) > (SELECT COUNT(*) FROM selected)) AS more
    FROM ${tableName} WHERE ${key} IN (SELECT ${aliases.join(",")} FROM selected) ORDER BY ${order}`)
      .bind(...bindings)
      .all<Record<string, unknown>>()
  ).results;
  const last = rows.at(-1)?.row_cursor;
  let typesColumn = "__sqlite_types";
  while (columns.some((column) => column.name === typesColumn)) typesColumn += "_";
  const header = [
    ...columns.map((column) => completeCsvCell(column.name)),
    completeCsvCell(typesColumn),
  ].join(",");
  const lines = rows.map((row) => {
    const types = String(row.types || "");
    return [
      ...columns.map((_, index) =>
        completeCsvCell(
          sqlValue(row[`v${index}`], types[index]),
          types[index] === "t" ? "text" : "value",
        ),
      ),
      completeCsvCell(types),
    ].join(",");
  });
  const more = rows.at(-1)?.more === 1;
  if (more && typeof last !== "string") throw new Error("complete_export_cursor_missing");
  return {
    bytes: new TextEncoder().encode(
      `\uFEFF${header}\r\n${lines.length ? lines.join("\r\n") + "\r\n" : ""}`,
    ),
    filename: table.name,
    rows: rows.length,
    next: more
      ? { table: cursor.table, after: String(last) }
      : { table: cursor.table + 1, after: null },
  };
}
