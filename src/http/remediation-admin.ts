import { isRecord } from "../types.js";
import type { FullRebuildOptions } from "../db/data-quality-remediation-queue-repository.js";
import type { CatalogRemediationOptions } from "../db/knowledge-catalog-remediation-repository.js";

export interface CatalogReplayAdminRequest {
  catalogProductId: number;
  replay: CatalogRemediationOptions;
}

export const DATA_QUALITY_REBUILD_ORDER = Object.freeze([
  "raw_source_fields",
  "canonical_manufacturer",
  "model",
  "category_features",
  "knowledge_catalog_candidates",
  "product_identity",
  "product_search_entities",
  "data_quality_snapshot",
] as const);

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

function optionalRebuildKey(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return key && key.length <= 100 && /^[A-Za-z0-9._:-]+$/.test(key) ? key : undefined;
}

/** Strict parser for one restartable full-remediation rebuild page. */
export function parseDataQualityRebuildRequest(
  value: unknown,
): Pick<FullRebuildOptions, "afterId" | "limit" | "rebuildKey"> | null {
  const replay = parseReplayRequest(value);
  if (!replay) return null;
  if (!isRecord(value) && value !== undefined) return null;
  const rebuildKey = isRecord(value) ? optionalRebuildKey(value.rebuildKey) : undefined;
  if (isRecord(value) && value.rebuildKey != null && rebuildKey === undefined) return null;
  return { ...replay, ...(rebuildKey ? { rebuildKey } : {}) };
}

export function parseCatalogReplayRequest(value: unknown): CatalogReplayAdminRequest | null {
  if (!isRecord(value)) return null;
  const catalogProductId = optionalNonNegativeInteger(value.catalogProductId);
  if (!catalogProductId) return null;
  const replay = parseReplayRequest(value);
  return replay ? { catalogProductId, replay } : null;
}
