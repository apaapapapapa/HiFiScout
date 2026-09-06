import { isRecord } from "../types.js";
import {
  ADMIN_CSV_FIELDS,
  ADMIN_CSV_MAX_VALUE_CHARACTERS,
  ADMIN_CSV_PREVIEW_LIMIT,
  isAdminCsvOriginal,
  isAdminCsvNewCatalog,
  type AdminCsvApplyInput,
  type AdminCsvChange,
} from "../api/admin-csv-contracts.js";
import { catalogIdentityKey } from "../catalog/knowledge-catalog-identity.js";

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function parseAdminCsvChange(value: unknown): AdminCsvChange | null {
  if (!isRecord(value) || !isRecord(value.original) || !isRecord(value.values)) return null;
  const original = value.original;
  if (
    (!isAdminCsvOriginal(original) && !isAdminCsvNewCatalog(original)) ||
    !Number.isSafeInteger(value.line) ||
    Number(value.line) <= 0
  )
    return null;
  const fields: readonly string[] = ADMIN_CSV_FIELDS[original.kind];
  const values = value.values;
  if (Object.keys(values).length !== fields.length) return null;
  // Existing dirty data must be correctable; reject newly introduced controls, not the before-image.
  if (
    !fields.every(
      (field) =>
        typeof values[field] === "string" &&
        values[field].length <= ADMIN_CSV_MAX_VALUE_CHARACTERS &&
        (values[field] === original.values[field] || !containsControlCharacter(values[field])),
    )
  )
    return null;
  return value as unknown as AdminCsvChange;
}

export function parseAdminCsvPreview(value: unknown): AdminCsvChange[] | null {
  if (!isRecord(value) || !Array.isArray(value.changes)) return null;
  if (!value.changes.length || value.changes.length > ADMIN_CSV_PREVIEW_LIMIT) return null;
  const changes = value.changes.map(parseAdminCsvChange);
  if (changes.some((change) => change === null)) return null;
  const valid = changes as AdminCsvChange[];
  const targets = new Set<string>();
  const identities = new Map<string, boolean>();
  for (const change of valid) {
    const { original, values } = change;
    if (original.id !== null) {
      const target = original.kind + ":" + original.id;
      if (targets.has(target)) return null;
      targets.add(target);
    }
    if (original.kind === "catalog") {
      const key = catalogIdentityKey(values.manufacturer_id, values.canonical_model);
      if (key && identities.has(key) && (identities.get(key) || original.id === null)) return null;
      if (key) identities.set(key, original.id === null);
    }
  }
  return valid;
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
