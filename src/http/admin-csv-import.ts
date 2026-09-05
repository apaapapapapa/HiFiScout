import { isRecord } from "../types.js";
import {
  ADMIN_CSV_FIELDS,
  ADMIN_CSV_PREVIEW_LIMIT,
  type AdminCsvApplyInput,
  type AdminCsvChange,
} from "../api/admin-csv-contracts.js";

export function parseAdminCsvChange(value: unknown): AdminCsvChange | null {
  if (!isRecord(value) || !isRecord(value.original) || !isRecord(value.values)) return null;
  const original = value.original;
  if (
    original.version !== 1 ||
    (original.kind !== "listing" && original.kind !== "catalog") ||
    !Number.isSafeInteger(original.id) ||
    Number(original.id) <= 0 ||
    !Number.isSafeInteger(value.line) ||
    Number(value.line) <= 0 ||
    !isRecord(original.values)
  )
    return null;
  const fields: readonly string[] = ADMIN_CSV_FIELDS[original.kind];
  for (const values of [original.values, value.values]) {
    if (Object.keys(values).length !== fields.length) return null;
    if (
      !fields.every(
        (field) =>
          typeof values[field] === "string" &&
          values[field].length <= 4096 &&
          !/[\u0000-\u001f\u007f]/u.test(values[field]),
      )
    )
      return null;
  }
  return value as unknown as AdminCsvChange;
}

export function parseAdminCsvPreview(value: unknown): AdminCsvChange[] | null {
  if (!isRecord(value) || !Array.isArray(value.changes)) return null;
  if (!value.changes.length || value.changes.length > ADMIN_CSV_PREVIEW_LIMIT) return null;
  const changes = value.changes.map(parseAdminCsvChange);
  if (changes.some((change) => change === null)) return null;
  const valid = changes as AdminCsvChange[];
  return new Set(valid.map(({ original }) => original.kind + ":" + original.id)).size ===
    valid.length
    ? valid
    : null;
}

export function parseAdminCsvApply(value: unknown): AdminCsvApplyInput | null {
  if (!isRecord(value)) return null;
  const change = parseAdminCsvChange(value.change);
  if (
    !change ||
    typeof value.revision !== "string" ||
    value.revision.length > 16_384 ||
    typeof value.operationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value.operationId,
    )
  )
    return null;
  return { change, revision: value.revision, operationId: value.operationId };
}
