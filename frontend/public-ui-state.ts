import type { ProductFilters } from "./filters.js";
import { DEFAULT_SORT, filterUrlParams } from "./filters.js";
import { normalizedSpecifications } from "./specification-filters.js";

export type PriceErrors = Partial<Record<"minPrice" | "maxPrice", string>>;

/** Parse whole yen or up to four decimal places in 万円, exactly, within the API's 12-digit bound. */
export function normalizePrice(value: string): string | null {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) return "";
  if (normalized.length > 40) return null;
  const match = normalized.match(
    /^((?:\d+|\d{1,3}(?:,\d{3})+))(?:\.(\d{1,4}))?\s*(万(?:円)?|円)?$/u,
  );
  if (!match) return null;
  const [, whole, fraction, unit] = match;
  const tenThousands = unit === "万" || unit === "万円";
  if (fraction && !tenThousands) return null;
  const amount =
    BigInt(whole.replaceAll(",", "")) * (tenThousands ? 10_000n : 1n) +
    BigInt(fraction?.padEnd(4, "0") ?? "0");
  return amount <= 999_999_999_999n ? String(amount) : null;
}

export function priceErrors(filters: Pick<ProductFilters, "minPrice" | "maxPrice">): PriceErrors {
  const min = normalizePrice(filters.minPrice);
  const max = normalizePrice(filters.maxPrice);
  const errors: PriceErrors = {};
  if (min === null)
    errors.minPrice = "0〜999,999,999,999円で入力してください（例: 100,000 / 10万 / 12.5万円）。";
  if (max === null)
    errors.maxPrice = "0〜999,999,999,999円で入力してください（例: 100,000 / 10万 / 12.5万円）。";
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
    shop: [],
    manufacturer: [],
    category: "",
    minPrice: "",
    maxPrice: "",
    features: [],
    facets: [],
    offerFacts: [],
    specificationFilters: {},
    inStock: false,
    recentOnly: false,
    priceDropped: false,
    favoritesOnly: false,
  };
}

export function clearedDetailFilters(filters: ProductFilters): ProductFilters {
  return {
    ...filters,
    shop: [],
    manufacturer: [],
    category: "",
    minPrice: "",
    maxPrice: "",
    features: [],
    facets: [],
    offerFacts: [],
    specificationFilters: {},
  };
}

export function initialFilters(filters: ProductFilters): ProductFilters {
  return { ...clearedFilters(filters), inStock: true, sort: DEFAULT_SORT };
}

export function normalizedProductFilters(filters: ProductFilters): ProductFilters | null {
  const prices = normalizedPriceFilters(filters);
  const specifications = normalizedSpecifications(filters.specificationFilters);
  return prices && specifications ? { ...prices, specificationFilters: specifications } : null;
}

/** Desktop detailed edits survive immediate query/sort/quick-filter changes without applying them. */
export function desktopPanelFilters(
  current: ProductFilters,
  draft: ProductFilters,
): ProductFilters {
  return {
    ...draft,
    q: current.q,
    sort: current.sort,
    inStock: current.inStock,
    recentOnly: current.recentOnly,
    priceDropped: current.priceDropped,
    favoritesOnly: current.favoritesOnly,
  };
}

export function sameFilters(left: ProductFilters, right: ProductFilters): boolean {
  return (
    left.favoritesOnly === right.favoritesOnly &&
    filterUrlParams(left, "list").toString() === filterUrlParams(right, "list").toString()
  );
}

export interface FilterRelaxation {
  id: string;
  label: string;
  filters: ProductFilters;
}

export function filterRelaxations(filters: ProductFilters): FilterRelaxation[] {
  const choices: FilterRelaxation[] = [];
  if (filters.minPrice || filters.maxPrice)
    choices.push({
      id: "price",
      label: "価格条件だけ解除",
      filters: { ...filters, minPrice: "", maxPrice: "" },
    });
  if (filters.recentOnly)
    choices.push({
      id: "recent",
      label: "新着48時間の条件だけ解除",
      filters: { ...filters, recentOnly: false },
    });
  if (filters.priceDropped)
    choices.push({
      id: "priceDropped",
      label: "値下げ条件だけ解除",
      filters: { ...filters, priceDropped: false },
    });
  if (
    !filters.favoritesOnly &&
    (filters.features.length ||
      filters.facets.length ||
      Object.values(filters.specificationFilters ?? {}).some(Boolean))
  )
    choices.push({
      id: "specifications",
      label: "機能・仕様だけ解除",
      filters: { ...filters, features: [], facets: [], specificationFilters: {} },
    });
  if (filters.inStock)
    choices.push({
      id: "stock",
      label: "売切れ・在庫不明も含める",
      filters: { ...filters, inStock: false },
    });
  if (!filters.favoritesOnly && filters.offerFacts?.length)
    choices.push({
      id: "offer",
      label: "状態・付属品・保証だけ解除",
      filters: { ...filters, offerFacts: [] },
    });
  if (filters.shop.length)
    choices.push({ id: "shop", label: "ショップ条件だけ解除", filters: { ...filters, shop: [] } });
  if (filters.q)
    choices.push({ id: "query", label: "検索語だけ解除", filters: { ...filters, q: "" } });
  if (filters.manufacturer.length)
    choices.push({
      id: "manufacturer",
      label: "メーカー条件だけ解除",
      filters: { ...filters, manufacturer: [] },
    });
  if (filters.category)
    choices.push({
      id: "category",
      label: "カテゴリ条件だけ解除",
      filters: { ...filters, category: "" },
    });
  return choices.slice(0, 3);
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
