import type { ProductFilters } from "./filters.js";

export type PriceErrors = Partial<Record<"minPrice" | "maxPrice", string>>;

/** Accept full-width digits and correctly grouped yen amounts without discarding invalid input. */
export function normalizePrice(value: string): string | null {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) return "";
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/u.test(normalized)) return null;
  const number = Number(normalized.replaceAll(",", ""));
  return Number.isSafeInteger(number) && number >= 0 ? String(number) : null;
}

export function priceErrors(filters: Pick<ProductFilters, "minPrice" | "maxPrice">): PriceErrors {
  const min = normalizePrice(filters.minPrice);
  const max = normalizePrice(filters.maxPrice);
  const errors: PriceErrors = {};
  if (min === null) errors.minPrice = "0以上の整数を入力してください（例: 100,000）。";
  if (max === null) errors.maxPrice = "0以上の整数を入力してください（例: 1,000,000）。";
  if (min && max && Number(min) > Number(max)) {
    errors.maxPrice = "最高価格は最低価格以上にしてください。";
  }
  return errors;
}

export function normalizedPriceFilters(filters: ProductFilters): ProductFilters | null {
  if (Object.keys(priceErrors(filters)).length) return null;
  return {
    ...filters,
    minPrice: normalizePrice(filters.minPrice)!,
    maxPrice: normalizePrice(filters.maxPrice)!,
  };
}

export function clearedFilters(filters: ProductFilters): ProductFilters {
  return {
    ...filters,
    q: "",
    shop: "",
    manufacturer: "",
    category: "",
    minPrice: "",
    maxPrice: "",
    features: [],
    facets: [],
    inStock: false,
    recentOnly: false,
    priceDropped: false,
    favoritesOnly: false,
  };
}

/** Storage can be unavailable in private browsing. Optional preferences must not stop boot. */
export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function savePreference(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
