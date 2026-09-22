import { categoryIdForFilter } from "../catalog/categories.js";
import { auctionInstant } from "../auctions/observations.js";

export const AUCTION_CURSOR_MS = 15 * 60_000;
export const AUCTION_SORTS = [
  "ending",
  "current_asc",
  "current_desc",
  "buy_asc",
  "buy_desc",
  "newest",
] as const;
export type AuctionSort = (typeof AUCTION_SORTS)[number];
export interface AuctionQuery {
  q: string[];
  manufacturer: string;
  category: string;
  model: string;
  minimum: number | null;
  maximum: number | null;
  buyMinimum: number | null;
  buyMaximum: number | null;
  buy: "any" | "set" | "none" | "unknown";
  state: "open" | "pending" | "ended" | "stale" | "unknown" | "unavailable" | "all";
  unit: "any" | "single" | "pair" | "set" | "unknown";
  subject: "any" | "main_unit" | "accessory" | "parts" | "empty_box" | "bundle" | "unknown";
  endBefore: string | null;
  sort: AuctionSort;
  catalog: number | null;
  limit: number;
}
export interface AuctionCursor {
  v: 1;
  query: string;
  expires: number;
  id: string;
  value: string | number | null;
}
export class AuctionQueryError extends Error {}
export const auctionQueryText = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const fail = (reason: string): never => {
  throw new AuctionQueryError(reason);
};
/** Pure validation before DO access; canonical conditions are also the cursor/cache identity. */
export function parseAuctionQuery(
  url: URL,
  now = Date.now(),
): { query: AuctionQuery; cursor: AuctionCursor | null; key: string } {
  const p = url.searchParams;
  const names = [
    "q",
    "manufacturer",
    "category",
    "model",
    "min",
    "max",
    "buyMin",
    "buyMax",
    "buy",
    "state",
    "unit",
    "subject",
    "endBefore",
    "sort",
    "catalog",
    "limit",
    "cursor",
  ];
  if ([...p.keys()].some((key) => !names.includes(key) || p.getAll(key).length !== 1))
    fail("invalid_auction_parameter");
  const text = (name: string, max = 80) => {
    const s = (p.get(name) ?? "").normalize("NFKC").trim();
    if (s.length > max || [...s].some((c) => c.charCodeAt(0) < 32)) fail("invalid_auction_text");
    return s;
  };
  const integer = (name: string, max = 1_000_000_000): number | null => {
    const s = p.get(name);
    if (s === null || s === "") return null;
    if (!/^\d{1,15}$/u.test(s)) return fail("invalid_auction_number");
    const n = Number(s);
    return Number.isSafeInteger(n) && n <= max ? n : fail("invalid_auction_number");
  };
  const option = <T extends string>(name: string, values: readonly T[], fallback: T): T => {
    const v = p.get(name) ?? fallback;
    return values.includes(v as T) ? (v as T) : fail("invalid_auction_option");
  };
  const q = text("q", 120).split(/\s+/u).filter(Boolean).map(auctionQueryText);
  if (q.length > 4 || q.some((term) => [...term].length < 3))
    fail("auction_query_minimum_3_characters_use_model_for_short_codes");
  const category = text("category");
  if (category && !categoryIdForFilter(category)) fail("invalid_auction_category");
  const normalized = (name: string) => {
    const raw = text(name);
    const value = auctionQueryText(raw);
    if (raw && !value) fail("invalid_auction_text");
    return value;
  };
  const query: AuctionQuery = {
    q,
    manufacturer: normalized("manufacturer"),
    category: categoryIdForFilter(category) ?? "",
    model: normalized("model"),
    minimum: integer("min"),
    maximum: integer("max"),
    buyMinimum: integer("buyMin"),
    buyMaximum: integer("buyMax"),
    buy: option("buy", ["any", "set", "none", "unknown"], "any"),
    state: option(
      "state",
      ["open", "pending", "ended", "stale", "unknown", "unavailable", "all"],
      "open",
    ),
    unit: option("unit", ["any", "single", "pair", "set", "unknown"], "any"),
    subject: option(
      "subject",
      ["any", "main_unit", "accessory", "parts", "empty_box", "bundle", "unknown"],
      "any",
    ),
    endBefore: p.has("endBefore") ? auctionInstant(p.get("endBefore")) : null,
    sort: option("sort", AUCTION_SORTS, "ending"),
    catalog: integer("catalog", Number.MAX_SAFE_INTEGER),
    limit: integer("limit", 25) ?? 25,
  };
  if (
    query.limit < 1 ||
    query.catalog === 0 ||
    (p.has("endBefore") && !query.endBefore) ||
    (query.minimum !== null && query.maximum !== null && query.minimum > query.maximum) ||
    (query.buyMinimum !== null && query.buyMaximum !== null && query.buyMinimum > query.buyMaximum)
  )
    fail("invalid_auction_range");
  const key = JSON.stringify(query);
  const encoded = p.get("cursor");
  let cursor: AuctionCursor | null = null;
  if (encoded !== null) {
    if (!encoded || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(encoded))
      fail("invalid_auction_cursor");
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
            c.charCodeAt(0),
          ),
        ),
      );
    } catch {
      return fail("invalid_auction_cursor");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
      fail("invalid_auction_cursor");
    const c = value as Partial<AuctionCursor>;
    if (
      c.v !== 1 ||
      c.query !== key ||
      typeof c.expires !== "number" ||
      !Number.isSafeInteger(c.expires) ||
      c.expires > now + AUCTION_CURSOR_MS ||
      typeof c.id !== "string" ||
      !/^[a-z][a-z0-9]{5,31}$/u.test(c.id) ||
      !(
        c.value === null ||
        (query.sort === "ending" || query.sort === "newest"
          ? typeof c.value === "string" && auctionInstant(c.value) === c.value
          : typeof c.value === "number" &&
            Number.isSafeInteger(c.value) &&
            c.value >= 0 &&
            c.value <= 1_000_000_000)
      )
    )
      fail("invalid_auction_cursor");
    if (c.expires! <= now) fail("expired_auction_cursor");
    cursor = c as AuctionCursor;
  }
  return { query, cursor, key };
}
export function encodeAuctionCursor(cursor: AuctionCursor): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(cursor))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}
