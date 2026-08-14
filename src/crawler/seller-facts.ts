import type { SellerProduct, ShopPlugin } from "./types.js";
import { isRecord } from "../types.js";

const PERSISTENCE_ONLY_FIELDS = [
  "id",
  "shop_key",
  "is_active",
  "first_seen_at",
  "last_seen_at",
  "last_changed_at",
  "last_activity_at",
] as const;

function invalid(shopKey: string, index: number, message: string): never {
  throw new Error(`invalid seller product ${shopKey}[${index}]: ${message}`);
}

function assertString(
  shopKey: string,
  index: number,
  product: Record<string, unknown>,
  field: string,
  nonEmpty = false,
): void {
  const value = product[field];
  if (typeof value !== "string") invalid(shopKey, index, `${field} must be a string`);
  if (nonEmpty && !value.trim()) invalid(shopKey, index, `${field} must not be empty`);
}

function assertSourceUrl(shopKey: string, index: number, value: string): void {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(value);
  } catch {
    invalid(shopKey, index, "sourceUrl must be an absolute URL");
  }
  if (sourceUrl.protocol !== "https:") invalid(shopKey, index, "sourceUrl must use https");
}

/**
 * Runtime boundary between untrusted seller parsing and the shared catalog pipeline.
 *
 * TypeScript catches first-party drift at compile time; this check also catches malformed values
 * produced from third-party markup before they can be normalized or reach persistence.
 */
export function validateSellerProducts(
  products: readonly SellerProduct[],
  plugin: Pick<ShopPlugin, "key">,
): SellerProduct[] {
  if (!Array.isArray(products))
    throw new Error(`invalid seller products ${plugin.key}: not an array`);

  return products.map((candidate, index) => {
    if (!isRecord(candidate)) invalid(plugin.key, index, "product must be an object");

    for (const field of PERSISTENCE_ONLY_FIELDS) {
      if (field in candidate) invalid(plugin.key, index, `${field} is persistence-only`);
    }

    assertString(plugin.key, index, candidate, "sourceId", true);
    assertString(plugin.key, index, candidate, "sourceUrl", true);
    assertString(plugin.key, index, candidate, "title", true);
    assertString(plugin.key, index, candidate, "manufacturer");
    assertString(plugin.key, index, candidate, "rawManufacturer");
    assertString(plugin.key, index, candidate, "model");
    assertString(plugin.key, index, candidate, "rawCategory");
    assertString(plugin.key, index, candidate, "category");
    assertString(plugin.key, index, candidate, "conditionText");

    const price = candidate.priceYen;
    if (price !== null && (!Number.isInteger(price) || Number(price) < 0)) {
      invalid(plugin.key, index, "priceYen must be a non-negative integer or null");
    }
    if (
      candidate.stockStatus !== "in_stock" &&
      candidate.stockStatus !== "sold_out" &&
      candidate.stockStatus !== "unknown"
    ) {
      invalid(plugin.key, index, "stockStatus must be in_stock, sold_out, or unknown");
    }

    assertSourceUrl(plugin.key, index, candidate.sourceUrl as string);

    if (
      candidate.sourcePublishedAt !== undefined &&
      candidate.sourcePublishedAt !== null &&
      typeof candidate.sourcePublishedAt !== "string"
    ) {
      invalid(plugin.key, index, "sourcePublishedAt must be a string or null");
    }
    if (candidate.metadata !== undefined && !isRecord(candidate.metadata)) {
      invalid(plugin.key, index, "metadata must be an object");
    }
    if (candidate.featureFacts !== undefined && !Array.isArray(candidate.featureFacts)) {
      invalid(plugin.key, index, "featureFacts must be an array");
    }
    if (candidate.categoryEvidence !== undefined && !Array.isArray(candidate.categoryEvidence)) {
      invalid(plugin.key, index, "categoryEvidence must be an array");
    }

    // The checks above are the runtime proof; TypeScript cannot derive a structural type from them.
    return candidate as unknown as SellerProduct;
  });
}
