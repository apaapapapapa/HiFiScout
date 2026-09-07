import type { MarketCondition, MarketPriceBand, MarketSaleUnit, ProductMarketAnalysis } from "../src/api/contracts.js";

export const MARKET_CONDITIONS: Record<MarketCondition, string> = {
  unused: "未使用品", display: "展示品", outlet: "アウトレット", used: "中古品", junk: "ジャンク",
  operation_unchecked: "動作未確認", operation_fault: "動作不良あり", mixed: "複数の状態の明記", unknown: "状態の記載なし・未確認",
};
export const MARKET_UNITS: Record<MarketSaleUnit, string> = { single: "単体", pair: "ペア", set: "セット", unknown: "記載なし・未確認" };
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 500;
const price = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const date = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));

function band(v: unknown, asOf: number): v is MarketPriceBand {
  if (!record(v) || !count(v.listing_count) || !count(v.shop_count) || v.shop_count > v.listing_count) return false;
  if (v.listing_count === 0) {
    if (v.first_observed_at !== null || v.last_observed_at !== null) return false;
  } else if (!date(v.first_observed_at) || !date(v.last_observed_at) || Date.parse(v.first_observed_at) > Date.parse(v.last_observed_at) || Date.parse(v.last_observed_at) > asOf) return false;
  if (v.listing_count < 3 || v.shop_count < 2) return v.median_yen === null && v.min_yen === null && v.max_yen === null;
  return price(v.min_yen) && price(v.median_yen) && price(v.max_yen) && v.min_yen <= v.median_yen && v.median_yen <= v.max_yen;
}

/** Reject malformed, duplicate or impossible summary data before it becomes a chart or a price claim. */
export function isProductMarketAnalysis(value: unknown): value is ProductMarketAnalysis {
  if (!record(value) || value.version !== 1 || !date(value.as_of) || !Array.isArray(value.current_conditions) || !Array.isArray(value.months)) return false;
  if (value.status === "limited") return value.current_conditions.length === 0 && value.months.length === 0;
  if (value.status !== "ready" || value.current_conditions.length > 36 || value.months.length !== 6) return false;
  const asOf = Date.parse(value.as_of), groups = new Set<string>(), months = new Set<string>();
  for (const group of value.current_conditions) {
    if (!band(group, asOf) || !record(group) || typeof group.condition !== "string" || !Object.hasOwn(MARKET_CONDITIONS, group.condition) || typeof group.sale_unit !== "string" || !Object.hasOwn(MARKET_UNITS, group.sale_unit)) return false;
    const key = `${group.condition}:${group.sale_unit}`;
    if (groups.has(key)) return false;
    groups.add(key);
  }
  for (const month of value.months) {
    if (!band(month, asOf) || !record(month) || typeof month.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month.month) || months.has(month.month) || !count(month.first_observed_listings) || !count(month.sold_out_listings) || !count(month.deactivated_listings)) return false;
    months.add(month.month);
  }
  const expected = Array.from({ length: 6 }, (_, index) => {
    const at = new Date(asOf);
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 5 + index, 1)).toISOString().slice(0, 7);
  });
  return [...months].every((month, index) => month === expected[index]);
}
