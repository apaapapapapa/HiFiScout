import { categoryIdForClassification, categoryIdForFilter } from "../catalog/categories.js";
import { manufacturerIdForFilter } from "../catalog/manufacturers.js";
import { isRecord } from "../types.js";

export type KnowledgeCatalogLifecycleStatus = "unknown" | "active" | "discontinued";

export interface KnowledgeCatalogAdminListOptions {
  query: string;
  manufacturerId: string;
  categoryId: string;
  afterId: number;
  limit: number;
}

export interface KnowledgeCatalogAdminUpdateInput {
  canonicalName: string;
  lifecycleStatus: KnowledgeCatalogLifecycleStatus;
  primaryCategoryId: string;
}

export interface KnowledgeCatalogAdminCreateInput extends KnowledgeCatalogAdminUpdateInput {
  manufacturerId: string;
  canonicalModel: string;
  sourceUrl: string;
}

export interface KnowledgeCatalogAdminMergeInput {
  sourceProductId: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function boundedText(value: string | null, maxLength: number): string | null {
  if (value === null) return "";
  const text = value.trim();
  return text.length <= maxLength ? text : null;
}

function optionalNonNegativeInteger(value: string | null, fallback: number): number | null {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseKnowledgeCatalogAdminListQuery(
  url: URL,
): KnowledgeCatalogAdminListOptions | null {
  const query = boundedText(url.searchParams.get("q"), 200);
  const manufacturerId = boundedText(url.searchParams.get("manufacturerId"), 100);
  if (query === null || manufacturerId === null) return null;
  if (manufacturerId && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manufacturerId.toLowerCase())) {
    return null;
  }

  const rawCategoryId = boundedText(url.searchParams.get("categoryId"), 100);
  if (rawCategoryId === null) return null;
  const categoryId = rawCategoryId ? categoryIdForFilter(rawCategoryId) : "";
  if (rawCategoryId && !categoryId) return null;

  const afterId = optionalNonNegativeInteger(url.searchParams.get("afterId"), 0);
  const requestedLimit = optionalNonNegativeInteger(url.searchParams.get("limit"), DEFAULT_LIMIT);
  if (
    afterId === null ||
    requestedLimit === null ||
    requestedLimit < 1 ||
    requestedLimit > MAX_LIMIT
  ) {
    return null;
  }

  return {
    query: query || "",
    manufacturerId: (manufacturerId || "").toLowerCase(),
    categoryId: categoryId || "",
    afterId,
    limit: requestedLimit,
  };
}

function bodyText(value: unknown, maxLength: number): string {
  return typeof value === "string" && value.trim().length <= maxLength ? value.trim() : "";
}

function lifecycleStatus(value: unknown): KnowledgeCatalogLifecycleStatus | null {
  return value === "unknown" || value === "active" || value === "discontinued" ? value : null;
}

function primaryCategory(value: unknown): string {
  const raw = bodyText(value, 100);
  return raw ? categoryIdForClassification(raw) || "" : "";
}

function sourceUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "";
  const text = bodyText(value, 1000);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function parseKnowledgeCatalogAdminUpdate(
  value: unknown,
): KnowledgeCatalogAdminUpdateInput | null {
  if (!isRecord(value)) return null;

  const canonicalName = bodyText(value.canonicalName, 300);
  const primaryCategoryId = primaryCategory(value.primaryCategoryId);
  const lifecycle = lifecycleStatus(value.lifecycleStatus);
  if (!canonicalName || !primaryCategoryId || !lifecycle) return null;

  return {
    canonicalName,
    lifecycleStatus: lifecycle,
    primaryCategoryId,
  };
}

export function parseKnowledgeCatalogAdminCreate(
  value: unknown,
): KnowledgeCatalogAdminCreateInput | null {
  if (!isRecord(value)) return null;
  const update = parseKnowledgeCatalogAdminUpdate(value);
  if (!update) return null;

  const rawManufacturer = bodyText(value.manufacturerId, 100);
  const manufacturerId = manufacturerIdForFilter(rawManufacturer);
  const canonicalModel = bodyText(value.canonicalModel, 200);
  const verifiedSourceUrl = sourceUrl(value.sourceUrl);
  if (!rawManufacturer || !manufacturerId || !canonicalModel || verifiedSourceUrl === null)
    return null;

  return {
    ...update,
    manufacturerId,
    canonicalModel,
    sourceUrl: verifiedSourceUrl,
  };
}

export function parseKnowledgeCatalogAdminMerge(
  value: unknown,
): KnowledgeCatalogAdminMergeInput | null {
  if (!isRecord(value)) return null;
  const sourceProductId = Number(value.sourceProductId);
  return Number.isSafeInteger(sourceProductId) && sourceProductId > 0 ? { sourceProductId } : null;
}
