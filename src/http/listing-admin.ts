import { categoryIdForClassification, categoryIdForFilter } from "../catalog/categories.js";
import { presentationColorLabel } from "../catalog/model-presentation-color.js";
import { isRecord } from "../types.js";

export interface ListingAdminListOptions {
  query: string;
  shopKey: string;
  categoryId: string;
  activeOnly: boolean;
  afterId: number;
  limit: number;
}

export interface ListingAdminUpdateInput {
  manufacturerId?: string;
  model?: string;
  presentationColor?: string;
  primaryCategoryId?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const ALLOWED_UPDATE_KEYS = new Set([
  "manufacturerId",
  "model",
  "presentationColor",
  "primaryCategoryId",
]);

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

export function parseListingAdminListQuery(url: URL): ListingAdminListOptions | null {
  const query = boundedText(url.searchParams.get("q"), 200);
  const shopKey = boundedText(url.searchParams.get("shopKey"), 100);
  if (query === null || shopKey === null) return null;
  if (shopKey && !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(shopKey.toLowerCase())) return null;

  const rawCategoryId = boundedText(url.searchParams.get("categoryId"), 100);
  if (rawCategoryId === null) return null;
  const categoryId = rawCategoryId ? categoryIdForFilter(rawCategoryId) : "";
  if (rawCategoryId && !categoryId) return null;

  const scope = (url.searchParams.get("scope") || "active").trim().toLowerCase();
  if (scope !== "active" && scope !== "all") return null;

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
    shopKey: (shopKey || "").toLowerCase(),
    categoryId: categoryId || "",
    activeOnly: scope === "active",
    afterId,
    limit: requestedLimit,
  };
}

function bodyText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length <= maxLength ? text : null;
}

function canonicalPresentationColor(value: string): string | null {
  return value ? presentationColorLabel(value) : "";
}

export function parseListingAdminUpdate(value: unknown): ListingAdminUpdateInput | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !ALLOWED_UPDATE_KEYS.has(key))) return null;

  const input: ListingAdminUpdateInput = {};
  if (Object.hasOwn(value, "manufacturerId")) {
    const manufacturerId = bodyText(value.manufacturerId, 100);
    if (manufacturerId === null) return null;
    const normalized = manufacturerId.toLowerCase();
    if (normalized && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized)) return null;
    input.manufacturerId = normalized;
  }

  if (Object.hasOwn(value, "model")) {
    const model = bodyText(value.model, 200);
    if (model === null) return null;
    input.model = model;
  }

  if (Object.hasOwn(value, "presentationColor")) {
    const presentationColor = bodyText(value.presentationColor, 100);
    if (presentationColor === null) return null;
    const canonical = canonicalPresentationColor(presentationColor);
    if (canonical === null) return null;
    input.presentationColor = canonical;
  }

  if (Object.hasOwn(value, "primaryCategoryId")) {
    const rawCategory = bodyText(value.primaryCategoryId, 100);
    if (!rawCategory) return null;
    const primaryCategoryId = categoryIdForClassification(rawCategory);
    if (!primaryCategoryId) return null;
    input.primaryCategoryId = primaryCategoryId;
  }

  return input;
}
