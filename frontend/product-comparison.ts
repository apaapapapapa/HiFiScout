import { isProductDetailResponse } from "./api-client.js";
import type { ApiClient } from "./api-client.js";
import type { DisplayProduct } from "./types.js";
import { validProductKey } from "./product-permalink.js";

export const MAX_COMPARISON_PRODUCTS = 4;

/** Canonical catalog identities only; reject an oversized or partly invalid selection as a whole. */
export function canonicalComparisonKeys(keys: readonly string[]): string[] {
  if (keys.length > 16 || keys.some((key) => !key.startsWith("c-") || !validProductKey(key)))
    return [];
  const unique = [...new Set(keys.map((key) => `c-${Number(key.slice(2))}`))];
  return unique.length > MAX_COMPARISON_PRODUCTS
    ? []
    : unique.sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

export function comparisonKeysFromSearch(search: string): string[] {
  const values = new URLSearchParams(search).getAll("compare");
  if (values.length > 4 || values.join(",").length > 256) return [];
  return values.length ? canonicalComparisonKeys(values.flatMap((value) => value.split(","))) : [];
}

export function comparisonPath(keys: readonly string[]): string | null {
  const canonical = canonicalComparisonKeys(keys);
  return canonical.length >= 2
    ? `/?${new URLSearchParams({ compare: canonical.join(",") })}`
    : null;
}

export interface ComparisonColumn {
  key: string;
  product: DisplayProduct | null;
}

/** At most four existing detail requests. A failed product keeps its own column. */
export async function loadComparisonProducts(
  api: ApiClient,
  keys: readonly string[],
  signal: AbortSignal,
  refresh = false,
): Promise<ComparisonColumn[]> {
  const canonical = canonicalComparisonKeys(keys);
  if (canonical.length < 2) return [];
  return Promise.all(
    canonical.map(async (key) => {
      try {
        const data = await api.fetchJson(`/api/product-search/${key}`, { signal, refresh });
        if (
          !isProductDetailResponse(data) ||
          data.product.key !== key ||
          data.product.catalog_product_id !== Number(key.slice(2)) ||
          data.product.identity_kind !== "catalog"
        )
          throw new TypeError("invalid_comparison_product");
        return { key, product: data.product };
      } catch (error) {
        if (signal.aborted) throw error;
        return { key, product: null };
      }
    }),
  );
}
