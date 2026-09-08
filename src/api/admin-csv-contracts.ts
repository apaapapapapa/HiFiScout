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
export const ADMIN_CSV_MAX_VALUE_CHARACTERS = 4_096;
export const ADMIN_CSV_MAX_REQUEST_BYTES = 256 * 1024;

export interface AdminCsvOriginal {
  version: 1;
  kind: AdminCsvKind;
  id: number;
  values: AdminCsvValues;
}

/** A catalog insertion has no database ID or before-image. Listing insertion is unsupported. */
export interface AdminCsvNewCatalog {
  version: 1;
  kind: "catalog";
  id: null;
  values: AdminCsvValues;
}

export function adminCsvNewCatalog(): AdminCsvNewCatalog {
  return {
    version: 1,
    kind: "catalog",
    id: null,
    values: Object.fromEntries(ADMIN_CSV_FIELDS.catalog.map((field) => [field, ""])),
  };
}

export interface AdminCsvChange {
  line: number;
  original: AdminCsvOriginal | AdminCsvNewCatalog;
  values: AdminCsvValues;
}

export interface AdminCsvResult {
  line: number;
  id: number | null;
  kind: AdminCsvKind;
  status: "ready" | "unchanged" | "conflict" | "invalid" | "pending" | "applied" | "failed";
  message: string;
  revision?: string;
  operationId?: string;
  /** Opaque server identity for cross-batch duplicate checks; the browser does not infer identity. */
  catalogIdentityKey?: string;
}

export function adminCsvPreviewResults(
  changes: readonly AdminCsvChange[],
  results: readonly AdminCsvResult[],
): AdminCsvResult[] {
  const checked = [...results];
  const identities = new Map<string, number>();
  results.forEach((row, index) => {
    const key = row.catalogIdentityKey;
    if (!key) return;
    const previous = identities.get(key);
    if (
      previous !== undefined &&
      (changes[previous].original.id === null || changes[index].original.id === null)
    ) {
      for (const duplicate of [previous, index])
        checked[duplicate] = {
          ...checked[duplicate],
          status: "invalid",
          message:
            results[previous].line + "行目と" + row.line + "行目のメーカー・型番が重複しています。",
        };
    } else identities.set(key, index);
  });
  return checked;
}

export interface AdminCsvApplyInput {
  change: AdminCsvChange;
  revision: string;
  operationId: string;
}

export type AdminJobStatus =
  | "uploading"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export interface AdminBackgroundJob {
  id: string;
  kind: "csv" | "replay";
  label: string;
  status: AdminJobStatus;
  createdAt: string;
  updatedAt: string;
  total: number;
  uploaded: number;
  processed: number;
  failed: number;
  error: string;
  expiresAt: string | null;
  detailsAvailable: boolean;
}
export type AdminJobCommand =
  | { action: "list"; before?: string }
  | { action: "get"; id: string; after?: number; failedOnly?: boolean }
  | { action: "create"; id: string; kind: "csv" | "replay"; total: number; label: string }
  | { action: "append"; id: string; offset: number; items: AdminCsvApplyInput[] }
  | { action: "start" | "pause" | "resume" | "retry" | "cancel"; id: string };
export interface AdminJobList {
  items: AdminBackgroundJob[];
  nextBefore: string | null;
}
export interface AdminJobDetail {
  job: AdminBackgroundJob;
  items: { ordinal: number; result: AdminCsvResult | null; state: string }[];
  nextAfter: number | null;
}

export function adminCsvOriginal(
  kind: AdminCsvKind,
  id: number,
  values: AdminCsvValues,
): AdminCsvOriginal {
  return { version: 1, kind, id, values };
}

const FORMULA_PREFIX = /^(?:\s*[=+\-@]|['\t\r\n])/u;

/** Escape a literal leading apostrophe too, making formula protection reversible on import. */
export function adminCsvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const safe = FORMULA_PREFIX.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export function adminCsvDecodeCell(value: string): string {
  return value.startsWith("'") && FORMULA_PREFIX.test(value.slice(1)) ? value.slice(1) : value;
}

export function isAdminCsvOriginal(value: unknown): value is AdminCsvOriginal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<AdminCsvOriginal>;
  if (row.version !== 1 || (row.kind !== "listing" && row.kind !== "catalog")) return false;
  if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0) return false;
  if (!row.values || typeof row.values !== "object" || Array.isArray(row.values)) return false;
  return (
    Object.keys(row.values).length === ADMIN_CSV_FIELDS[row.kind].length &&
    ADMIN_CSV_FIELDS[row.kind].every(
      (field) =>
        typeof row.values?.[field] === "string" &&
        row.values[field].length <= ADMIN_CSV_MAX_VALUE_CHARACTERS,
    )
  );
}

export function isAdminCsvNewCatalog(value: unknown): value is AdminCsvNewCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<AdminCsvNewCatalog>;
  return (
    row.version === 1 &&
    row.kind === "catalog" &&
    row.id === null &&
    !!row.values &&
    typeof row.values === "object" &&
    !Array.isArray(row.values) &&
    Object.keys(row.values).length === ADMIN_CSV_FIELDS.catalog.length &&
    ADMIN_CSV_FIELDS.catalog.every((field) => row.values?.[field] === "")
  );
}

/** Bound the encoded JSON body as well as the row count (UTF-8 and JSON escapes both matter). */
export function* adminCsvPreviewBatches(
  changes: readonly AdminCsvChange[],
): Generator<AdminCsvChange[]> {
  const encoder = new TextEncoder();
  const envelopeBytes = encoder.encode('{"changes":[]}').length;
  let batch: AdminCsvChange[] = [];
  let bytes = envelopeBytes;
  for (const change of changes) {
    const size = encoder.encode(JSON.stringify(change)).length;
    if (size + envelopeBytes > ADMIN_CSV_MAX_REQUEST_BYTES - 1024) {
      throw new Error(change.line + "行目: 修正データがリクエスト上限を超えています。");
    }
    if (
      batch.length &&
      (batch.length >= ADMIN_CSV_PREVIEW_LIMIT || bytes + size + 1 > ADMIN_CSV_MAX_REQUEST_BYTES)
    ) {
      yield batch;
      batch = [];
      bytes = envelopeBytes;
    }
    bytes += size + (batch.length ? 1 : 0);
    batch.push(change);
  }
  if (batch.length) yield batch;
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
