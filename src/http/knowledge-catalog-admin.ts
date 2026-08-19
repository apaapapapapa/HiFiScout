import {
  categoryIdForClassification,
  categoryIdForFilter,
} from "../catalog/categories.js";
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
  if (
    manufacturerId &&
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manufacturerId.toLowerCase())
  ) {
    return null;
  }

  const rawCategoryId = boundedText(url.searchParams.get("categoryId"), 100);
  if (rawCategoryId === null) return null;
  const categoryId = rawCategoryId ? categoryIdForFilter(rawCategoryId) : "";
  if (rawCategoryId && !categoryId) return null;

  const afterId = optionalNonNegativeInteger(url.searchParams.get("afterId"), 0);
  const requestedLimit = optionalNonNegativeInteger(url.searchParams.get("limit"), DEFAULT_LIMIT);
  if (afterId === null || requestedLimit === null || requestedLimit < 1 || requestedLimit > MAX_LIMIT) {
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

export function parseKnowledgeCatalogAdminUpdate(
  value: unknown,
): KnowledgeCatalogAdminUpdateInput | null {
  if (!isRecord(value)) return null;

  const canonicalName = bodyText(value.canonicalName, 300);
  const primaryCategoryValue = bodyText(value.primaryCategoryId, 100);
  const primaryCategoryId = primaryCategoryValue
    ? categoryIdForClassification(primaryCategoryValue)
    : null;
  const lifecycleStatus = value.lifecycleStatus;

  if (!canonicalName || !primaryCategoryId) return null;
  if (
    lifecycleStatus !== "unknown" &&
    lifecycleStatus !== "active" &&
    lifecycleStatus !== "discontinued"
  ) {
    return null;
  }

  return {
    canonicalName,
    lifecycleStatus,
    primaryCategoryId,
  };
}
