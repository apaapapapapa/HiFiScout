import { isProductDetailResponse } from "./api-client.js";
import type { ApiClient } from "./api-client.js";
import { validProductKey } from "./product-permalink.js";
import type { ProductDetailResponse } from "./types.js";

export const WATCH_OBSERVATIONS_KEY = "hifiscout:watch-observations:v1";
export const MAX_WATCH_REFRESH = 10;
export const MAX_WATCH_OBSERVATIONS = 50;
const MAX_OFFERS = 200;
export interface WatchedOffer {
  id: number;
  shopKey: string;
  priceYen: number | null;
  stock: "in_stock" | "sold_out" | "unknown";
}
export interface WatchObservation {
  key: string;
  checkedAt: string;
  complete: boolean;
  offers: WatchedOffer[];
}
export interface WatchChange {
  kind: "new" | "price" | "sold_out" | "missing";
  offer: WatchedOffer;
  previousPriceYen?: number;
}
export interface WatchRefreshResult {
  key: string;
  detail: ProductDetailResponse | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function watchedOffer(value: unknown): value is WatchedOffer {
  return (
    record(value) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.shopKey === "string" &&
    value.shopKey.length <= 80 &&
    (value.priceYen === null ||
      (typeof value.priceYen === "number" &&
        Number.isSafeInteger(value.priceYen) &&
        value.priceYen >= 0)) &&
    ["in_stock", "sold_out", "unknown"].includes(String(value.stock))
  );
}

export function parseWatchObservations(raw: string | null): WatchObservation[] {
  if (!raw || raw.length > 2_000_000) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data) || data.length > MAX_WATCH_OBSERVATIONS) return [];
    const entries = new Map<string, WatchObservation>();
    for (const value of data) {
      if (
        !record(value) ||
        typeof value.key !== "string" ||
        !validProductKey(value.key) ||
        typeof value.checkedAt !== "string" ||
        !Number.isFinite(Date.parse(value.checkedAt)) ||
        typeof value.complete !== "boolean" ||
        !Array.isArray(value.offers) ||
        value.offers.length > MAX_OFFERS ||
        !value.offers.every(watchedOffer) ||
        new Set(value.offers.map((offer) => offer.id)).size !== value.offers.length
      )
        continue;
      entries.set(value.key, {
        key: value.key,
        checkedAt: value.checkedAt,
        complete: value.complete,
        offers: value.offers,
      });
    }
    return [...entries.values()];
  } catch {
    return [];
  }
}

export function captureWatchObservation(
  detail: ProductDetailResponse,
  checkedAt: string,
): WatchObservation {
  return {
    key: detail.product.key,
    checkedAt,
    // A capped or inconsistent result cannot prove another listing disappeared.
    complete:
      detail.offers.length < MAX_OFFERS && detail.offers.length === detail.product.offer_count,
    offers: detail.offers.slice(0, MAX_OFFERS).map((offer) => ({
      id: offer.listing_product_id,
      shopKey: offer.shop_key,
      priceYen: offer.price_yen,
      stock: offer.stock_status,
    })),
  };
}

export function compareWatchObservations(
  before: WatchObservation | undefined,
  after: WatchObservation,
): WatchChange[] {
  if (!before || before.key !== after.key) return [];
  const previous = new Map(before.offers.map((offer) => [offer.id, offer]));
  const current = new Set(after.offers.map((offer) => offer.id));
  const changes: WatchChange[] = [];
  for (const offer of after.offers) {
    const old = previous.get(offer.id);
    if (!old) {
      if (before.complete) changes.push({ kind: "new", offer });
      continue;
    }
    if (old.priceYen !== null && offer.priceYen !== null && old.priceYen !== offer.priceYen)
      changes.push({ kind: "price", offer, previousPriceYen: old.priceYen });
    if (old.stock === "in_stock" && offer.stock === "sold_out")
      changes.push({ kind: "sold_out", offer });
  }
  if (after.complete)
    for (const offer of before.offers) {
      if (!current.has(offer.id)) changes.push({ kind: "missing", offer });
    }
  return changes;
}

/** Keep only the most recently checked products; failures never erase prior observations. */
export function mergeWatchObservations(
  previous: readonly WatchObservation[],
  next: readonly WatchObservation[],
): WatchObservation[] {
  const all = new Map(previous.map((entry) => [entry.key, entry]));
  for (const entry of next) {
    const before = all.get(entry.key);
    if (!before || Date.parse(entry.checkedAt) >= Date.parse(before.checkedAt))
      all.set(entry.key, entry);
  }
  return [...all.values()]
    .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt))
    .slice(-MAX_WATCH_OBSERVATIONS);
}

/** Ten user-visible favorites at most, two concurrent requests, with no timer or background loop. */
export async function refreshWatchedProducts(
  api: ApiClient,
  keys: readonly string[],
  signal: AbortSignal,
): Promise<WatchRefreshResult[]> {
  signal.throwIfAborted();
  if (keys.length > MAX_WATCH_REFRESH || keys.some((key) => !validProductKey(key)))
    throw new Error("invalid_watch_scope");
  const unique = [...new Set(keys)];
  const results: WatchRefreshResult[] = unique.map((key) => ({ key, detail: null }));
  let cursor = 0;
  const worker = async () => {
    while (cursor < unique.length) {
      signal.throwIfAborted();
      const index = cursor++,
        key = unique[index];
      try {
        const value = await api.fetchJson(`/api/product-search/${key}`, { signal, refresh: true });
        if (
          !isProductDetailResponse(value) ||
          value.product.key !== key ||
          value.offers.length > MAX_OFFERS ||
          (key.startsWith("c-")
            ? value.product.identity_kind !== "catalog" ||
              value.product.catalog_product_id !== Number(key.slice(2))
            : value.product.identity_kind !== "unresolved_listing" ||
              value.product.catalog_product_id !== null)
        )
          throw new Error("invalid_watch_detail");
        const snapshot = captureWatchObservation(value, new Date().toISOString());
        if (
          !snapshot.offers.every(watchedOffer) ||
          new Set(snapshot.offers.map((offer) => offer.id)).size !== snapshot.offers.length
        )
          throw new Error("invalid_watch_offers");
        results[index] = { key, detail: value };
      } catch (error) {
        if (signal.aborted) throw error;
        results[index] = { key, detail: null };
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return results;
}
