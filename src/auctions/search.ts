import { AUCTION_CURSOR_MS, encodeAuctionCursor, parseAuctionQuery } from "../api/auction-query.js";
import type { AuctionSearchResult } from "../api/auction-contracts.js";
import { categoryFilterIds } from "../catalog/categories.js";
import { AuctionStore } from "./storage.js";
import { AUCTION_CATALOG_RULE, currentAuctionIdentity } from "./catalog.js";
import { toAuctionOffer, type AuctionPublicIdentity } from "./public-offer.js";
import type { AuctionItemFacts, AuctionSnapshot } from "./types.js";
import { AUCTION_FRESH_MS } from "./runtime-policy.js";

export function searchAuctions(store: AuctionStore, url: URL, now: number): AuctionSearchResult {
  const { query: q, cursor, key } = parseAuctionQuery(url, now);
  const at = new Date(now).toISOString();
  const terms: string[] = [];
  const params: SqlStorageValue[] = [];
  const where = (sql: string, ...values: SqlStorageValue[]) => {
    terms.push(sql);
    params.push(...values);
  };
  const validIdentity =
    "c.expires>? AND json_extract(c.value,'$.rule')=? AND i.match_revision=json_extract(c.value,'$.revision')";
  if (q.catalog !== null || q.manufacturer || q.category)
    where(validIdentity, now, AUCTION_CATALOG_RULE);
  if (q.catalog !== null) where("i.catalog_id=?", q.catalog);
  if (q.manufacturer) where("i.manufacturer=?", q.manufacturer);
  if (q.category)
    where(
      "i.category IN (SELECT value FROM json_each(?))",
      JSON.stringify(categoryFilterIds(q.category)),
    );
  if (q.model) {
    const points = [...q.model];
    const last = points.pop()!;
    const upper = points.join("") + String.fromCodePoint(last.codePointAt(0)! + 1);
    where("i.model_key>=? AND i.model_key<?", q.model, upper);
  }
  if (q.q.length)
    where(
      "i.id IN (SELECT rowid FROM auction_fts WHERE auction_fts MATCH ?)",
      q.q.map((term) => '"' + term.replace(/"/g, '""') + '"').join(" AND "),
    );
  for (const [column, min, max] of [
    ["l.current_price", q.minimum, q.maximum],
    ["l.buy_price", q.buyMinimum, q.buyMaximum],
  ] as const) {
    if (min !== null) where(`${column}>=?`, min);
    if (max !== null) where(`${column}<=?`, max);
  }
  if (q.buy !== "any") where("l.buy_status=?", q.buy);
  if (q.unit !== "any") where("json_extract(i.item,'$.saleUnit')=?", q.unit);
  if (q.subject !== "any") where("json_extract(i.item,'$.saleSubject')=?", q.subject);
  if (q.endBefore) where("l.end_at<=?", q.endBefore);
  const phase =
    "CASE WHEN l.observed_at>? OR l.state_at>? THEN 'unknown' WHEN l.state IN ('ended','unavailable') THEN l.state WHEN l.end_at<=? THEN 'pending' ELSE coalesce(l.state,'unknown') END";
  if (q.state === "open") {
    where(`${phase}='open'`, at, at, at);
    where("l.state_at>=?", new Date(now - AUCTION_FRESH_MS).toISOString());
  } else if (q.state === "stale")
    where("l.state_at<? AND l.observed_at<=?", new Date(now - AUCTION_FRESH_MS).toISOString(), at);
  else if (q.state !== "all") where(`${phase}=?`, at, at, at, q.state);
  const column =
    q.sort === "ending"
      ? "l.end_at"
      : q.sort === "newest"
        ? "l.observed_at"
        : q.sort.startsWith("buy")
          ? "l.buy_price"
          : "l.current_price";
  const direction = q.sort.endsWith("desc") || q.sort === "newest" ? "DESC" : "ASC";
  if (cursor) {
    if (cursor.value === null) where(`${column} IS NULL AND l.auction_id>?`, cursor.id);
    else
      where(
        `(${column} IS NULL OR ${column}${direction === "ASC" ? ">" : "<"}? OR (${column}=? AND l.auction_id>?))`,
        cursor.value,
        cursor.value,
        cursor.id,
      );
  }
  const rows = store.sql<{
    auction_id: string;
    source_url: string;
    item: string;
    live: string;
    identity: string;
    match_revision: string;
    cache: string | null;
    expires: number | null;
    sort_value: string | number | null;
  }>(
    "search",
    `SELECT i.auction_id,i.source_url,i.item,l.value live,i.identity,i.match_revision,c.value cache,c.expires,${column} sort_value
    FROM auction_live_state l JOIN auction_items i USING(auction_id) LEFT JOIN catalog_match_cache c ON c.key=i.match_key
    ${terms.length ? "WHERE " + terms.join(" AND ") : ""} ORDER BY ${column} ${direction} NULLS LAST,l.auction_id ASC LIMIT ?`,
    ...params,
    q.limit + 1,
  );
  const hasMore = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  let validUntil = now + 60_000;
  const items = page.map((row) => {
    const identity = currentAuctionIdentity(
      JSON.parse(row.identity) as AuctionPublicIdentity,
      row.match_revision,
      row.cache !== null && row.expires !== null
        ? { value: row.cache, expires: row.expires }
        : null,
      now,
    );
    if (identity.catalogProductId !== null && row.expires !== null)
      validUntil = Math.min(validUntil, row.expires);
    const live = JSON.parse(row.live) as Pick<AuctionSnapshot, "stamp" | "live" | "cycle">;
    return toAuctionOffer(
      {
        ...live,
        source: "yahoo-auctions",
        auctionId: row.auction_id,
        sourceUrl: row.source_url,
        item: JSON.parse(row.item) as AuctionItemFacts,
      },
      identity,
      at,
    );
  });
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeAuctionCursor({
            v: 1,
            query: key,
            expires: cursor?.expires ?? now + AUCTION_CURSOR_MS,
            id: last.auction_id,
            value: last.sort_value,
          })
        : null,
    observedAt: at,
    validUntil: new Date(validUntil).toISOString(),
    coverage: store.runtime(now).coverage,
  };
}
