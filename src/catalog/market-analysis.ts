import type { MarketCondition, MarketPriceBand, MarketSaleUnit, ProductMarketAnalysis } from "./types.js";

export interface MarketOffer {
  id: number;
  shop_key: string;
  price_yen: number | null;
  stock_status: string;
  is_active: number;
  last_seen_at: string;
}
export interface MarketSample {
  id: number;
  listing_product_id: number;
  shop_key: string;
  price_yen: number | null;
  sample_kind: string;
  signal_kind: string;
  observed_at: string;
}
interface Quote { id: number; shop: string; price: number; at: string }
const CONDITION_IDS = ["unused", "display", "outlet", "junk", "operation_unchecked", "operation_fault"] as const;
const DAY = 86_400_000;

/** No quality score: conflicting explicit conditions remain their own unknown-quality group. */
function condition(facts: readonly string[]): MarketCondition {
  const selected = CONDITION_IDS.filter((id) => facts.includes(id));
  return selected.length > 1 ? "mixed" : selected[0] ?? (facts.includes("used") ? "used" : "unknown");
}
function saleUnit(facts: readonly string[]): MarketSaleUnit {
  const units = (["single", "pair", "set"] as const).filter((unit) => facts.includes(`sale_${unit}`));
  return units.length === 1 ? units[0] : "unknown";
}
function band(quotes: readonly Quote[]): MarketPriceBand {
  const prices = quotes.map((quote) => quote.price).sort((a, b) => a - b);
  const shops = new Set(quotes.map((quote) => quote.shop));
  const dates = quotes.map((quote) => quote.at).sort();
  const enough = prices.length >= 3 && shops.size >= 2;
  const middle = Math.floor(prices.length / 2);
  return {
    listing_count: prices.length, shop_count: shops.size,
    median_yen: enough ? Math.round((prices[middle] + prices[Math.floor((prices.length - 1) / 2)]) / 2) : null,
    min_yen: enough ? prices[0] : null, max_yen: enough ? prices.at(-1)! : null,
    first_observed_at: dates[0] ?? null, last_observed_at: dates.at(-1) ?? null,
  };
}

/** One quote per independent listing per month; never applies today's condition to historical quotes. */
export function calculateMarketAnalysis(
  offers: readonly MarketOffer[], facts: ReadonlyMap<number, readonly string[]>,
  samples: readonly MarketSample[], now: Date,
): ProductMarketAnalysis {
  const groups = new Map<string, { condition: MarketCondition; sale_unit: MarketSaleUnit; quotes: Quote[] }>();
  for (const offer of offers) {
    if (!offer.is_active || offer.stock_status !== "in_stock" || offer.price_yen === null || offer.price_yen < 0) continue;
    const observed = Date.parse(offer.last_seen_at);
    if (!Number.isFinite(observed) || observed > now.getTime() || observed < now.getTime() - 90 * DAY) continue;
    const evidence = facts.get(offer.id) ?? [];
    const c = condition(evidence), unit = saleUnit(evidence), key = `${c}:${unit}`;
    const group = groups.get(key) ?? { condition: c, sale_unit: unit, quotes: [] };
    group.quotes.push({ id: offer.id, shop: offer.shop_key, price: offer.price_yen, at: new Date(observed).toISOString() });
    groups.set(key, group);
  }
  const months = Array.from({ length: 6 }, (_, index) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + index, 1)).toISOString().slice(0, 7));
  const valid = samples.filter((sample) => Number.isFinite(Date.parse(sample.observed_at)) && Date.parse(sample.observed_at) <= now.getTime());
  const firstAsking = new Map<number, string>();
  for (const sample of valid) {
    if (sample.sample_kind !== "asking") continue;
    const month = new Date(sample.observed_at).toISOString().slice(0, 7);
    const before = firstAsking.get(sample.listing_product_id);
    if (!before || month < before) firstAsking.set(sample.listing_product_id, month);
  }
  return {
    version: 1, status: "ready", as_of: now.toISOString(),
    current_conditions: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => ({
      condition: group.condition, sale_unit: group.sale_unit, ...band(group.quotes),
    })),
    months: months.map((month) => {
      const asking = new Map<number, MarketSample>();
      const sold = new Set<number>(), removed = new Set<number>();
      for (const sample of valid) {
        if (new Date(sample.observed_at).toISOString().slice(0, 7) !== month) continue;
        if (sample.sample_kind === "asking" && sample.price_yen !== null) {
          const before = asking.get(sample.listing_product_id);
          if (!before || Date.parse(sample.observed_at) > Date.parse(before.observed_at) || (Date.parse(sample.observed_at) === Date.parse(before.observed_at) && sample.id > before.id)) asking.set(sample.listing_product_id, sample);
        }
        if (sample.signal_kind === "sold_out") sold.add(sample.listing_product_id);
        if (sample.signal_kind === "deactivated") removed.add(sample.listing_product_id);
      }
      return { month, ...band([...asking.values()].map((sample) => ({ id: sample.listing_product_id, shop: sample.shop_key, price: sample.price_yen!, at: new Date(sample.observed_at).toISOString() }))),
        first_observed_listings: [...firstAsking.values()].filter((value) => value === month).length,
        sold_out_listings: sold.size, deactivated_listings: removed.size,
      };
    }),
  };
}
