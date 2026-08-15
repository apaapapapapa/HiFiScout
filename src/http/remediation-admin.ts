import { isRecord } from "../types.js";
import type { CatalogRemediationOptions } from "../db/knowledge-catalog-remediation-repository.js";

export interface CatalogReplayAdminRequest {
  catalogProductId: number;
  replay: CatalogRemediationOptions;
}

export function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Cursor and page size for a bounded replay. Returns `null` for a present-but-invalid field so a
 * typo cannot silently restart a replay from the beginning of the table.
 */
export function parseReplayRequest(value: unknown): CatalogRemediationOptions | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const afterId = optionalNonNegativeInteger(value.afterId);
  const limit = optionalNonNegativeInteger(value.limit);
  if (value.afterId != null && afterId === undefined) return null;
  if (value.limit != null && (limit === undefined || limit === 0)) return null;
  return { afterId, limit };
}

export function parseCatalogReplayRequest(value: unknown): CatalogReplayAdminRequest | null {
  if (!isRecord(value)) return null;
  const catalogProductId = optionalNonNegativeInteger(value.catalogProductId);
  if (!catalogProductId) return null;
  const replay = parseReplayRequest(value);
  return replay ? { catalogProductId, replay } : null;
}
