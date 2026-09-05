/** Browser-safe vocabulary for round-tripping the two admin CSV exports. */
export type AdminCsvKind = "listing" | "catalog";
export type AdminCsvValues = Record<string, string>;

export const ADMIN_CSV_FIELDS = {
  listing: ["manufacturer_id", "model", "primary_category_id"],
  catalog: [
    "manufacturer_id",
    "canonical_model",
    "canonical_name",
    "primary_category_id",
    "lifecycle_status",
  ],
} as const;
export const ADMIN_CSV_PREVIEW_LIMIT = 20;
export const ADMIN_CSV_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const ADMIN_CSV_MAX_ROWS = 225_000;

export interface AdminCsvOriginal {
  version: 1;
  kind: AdminCsvKind;
  id: number;
  values: AdminCsvValues;
}

export interface AdminCsvChange {
  line: number;
  original: AdminCsvOriginal;
  values: AdminCsvValues;
}

export interface AdminCsvResult {
  line: number;
  id: number;
  kind: AdminCsvKind;
  status: "ready" | "unchanged" | "conflict" | "invalid" | "pending" | "applied" | "failed";
  message: string;
  revision?: string;
  operationId?: string;
}

export interface AdminCsvApplyInput {
  change: AdminCsvChange;
  revision: string;
  operationId: string;
}

export function adminCsvOriginal(
  kind: AdminCsvKind,
  id: number,
  values: AdminCsvValues,
): AdminCsvOriginal {
  return { version: 1, kind, id, values };
}

/** Escape a literal leading apostrophe too, making formula protection reversible on import. */
export function adminCsvCell(value: string): string {
  const safe = /^(?:\s*[=+\-@]|['\t\r\n])/u.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export function adminCsvEditHeader(kind: AdminCsvKind): string {
  return ["csv_original", ...ADMIN_CSV_FIELDS[kind].map((field) => "edit_" + field)].join(",");
}

export function adminCsvEditRow(original: AdminCsvOriginal): string {
  return [
    JSON.stringify(original),
    ...ADMIN_CSV_FIELDS[original.kind].map((field) => original.values[field] ?? ""),
  ]
    .map(adminCsvCell)
    .join(",");
}
