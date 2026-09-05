import {
  ADMIN_CSV_FIELDS,
  ADMIN_CSV_MAX_ROWS,
  type AdminCsvChange,
  type AdminCsvOriginal,
} from "../src/api/admin-csv-contracts.js";

/** RFC 4180, including embedded newlines, escaped quotes, CRLF and a UTF-8 BOM. */
export function* parseCsv(text: string): Generator<{ line: number; cells: string[] }> {
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  let line = 1;
  let rowLine = 1;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\0") throw new Error("CSVにNUL文字が含まれています。");
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        cell += character;
        if (character === "\n") line += 1;
      }
    } else if (character === "," || character === "\r" || character === "\n") {
      cells.push(cell);
      cell = "";
      closed = false;
      if (character !== ",") {
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        yield { line: rowLine, cells };
        cells = [];
        line += 1;
        rowLine = line;
      }
    } else if (character === '"' && cell === "" && !closed) {
      quoted = true;
    } else {
      if (closed || character === '"') throw new Error(line + "行目: CSVの引用符が不正です。");
      cell += character;
    }
    if (cell.length > 65_536 || cells.length > 200) {
      throw new Error(rowLine + "行目: セルまたは列数が上限を超えています。");
    }
  }
  if (quoted) throw new Error(rowLine + "行目: CSVの引用符が閉じられていません。");
  if (cell || closed || cells.length) yield { line: rowLine, cells: [...cells, cell] };
}

function originalValue(value: unknown): value is AdminCsvOriginal {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<AdminCsvOriginal>;
  if (row.version !== 1 || (row.kind !== "listing" && row.kind !== "catalog")) return false;
  if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0) return false;
  if (!row.values || typeof row.values !== "object" || Array.isArray(row.values)) return false;
  return ADMIN_CSV_FIELDS[row.kind].every((field) => typeof row.values?.[field] === "string");
}

export function readAdminCsv(text: string): {
  totalRows: number;
  unchangedRows: number;
  changes: AdminCsvChange[];
} {
  const iterator = parseCsv(text);
  const header = iterator.next().value?.cells as string[] | undefined;
  if (!header || new Set(header).size !== header.length) {
    throw new Error("CSVヘッダーが空、または列名が重複しています。");
  }
  const originalIndex = header.indexOf("csv_original");
  if (originalIndex < 0) throw new Error("編集対応のCSVを管理画面から再生成してください。");
  const indexes = new Map(header.map((name, index) => [name, index]));
  const seen = new Set<string>();
  const changes: AdminCsvChange[] = [];
  let totalRows = 0;
  for (const { line, cells } of iterator) {
    if (cells.length === 1 && cells[0] === "") continue;
    totalRows += 1;
    if (totalRows > ADMIN_CSV_MAX_ROWS) throw new Error("CSVの行数が上限を超えています。");
    if (cells.length !== header.length) throw new Error(line + "行目: 列数が一致しません。");
    let original: unknown;
    try {
      original = JSON.parse(cells[originalIndex]);
    } catch {
      throw new Error(line + "行目: csv_originalを変更せず、CSVを再生成してください。");
    }
    if (!originalValue(original)) throw new Error(line + "行目: 元データの形式が不正です。");
    const key = original.kind + ":" + original.id;
    if (seen.has(key)) throw new Error(line + "行目: 対象IDが重複しています。");
    seen.add(key);
    const idColumn = original.kind === "listing" ? "listing_id" : "catalog_product_id";
    if (cells[indexes.get(idColumn) ?? -1] !== String(original.id)) {
      throw new Error(line + "行目: 対象IDは変更できません。");
    }
    const values: Record<string, string> = {};
    for (const field of ADMIN_CSV_FIELDS[original.kind]) {
      const index = indexes.get("edit_" + field);
      if (index === undefined) throw new Error("edit_" + field + "列がありません。");
      const value = cells[index];
      values[field] = /^'(?:\s*[=+\-@]|['\t\r\n])/u.test(value) ? value.slice(1) : value;
      // Detect accidentally editing the original canonical columns instead of edit_*.
      const sourceField =
        original.kind === "listing" && field === "manufacturer_id"
          ? "canonical_manufacturer_id"
          : field;
      const sourceIndex = indexes.get(sourceField);
      if (sourceIndex !== undefined) {
        const source = cells[sourceIndex];
        const expected = original.values[field];
        if (source !== expected && source !== "'" + expected) {
          throw new Error(
            line + "行目: " + sourceField + "は元データ列です。edit_列を編集してください。",
          );
        }
      }
    }
    if (Object.keys(values).some((field) => values[field] !== original.values[field])) {
      changes.push({ line, original, values });
    }
  }
  if (!totalRows) throw new Error("CSVにデータ行がありません。");
  return { totalRows, unchangedRows: totalRows - changes.length, changes };
}
