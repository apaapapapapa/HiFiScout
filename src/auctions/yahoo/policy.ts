/** Admission policy for #703. Acquisition and serving require verified evidence gates. */
export const YAHOO_AUCTION_SOURCE = "yahoo-auctions" as const;
export const YAHOO_AUCTION_ORIGIN = "https://auctions.yahoo.co.jp";

/** Exact discovery buckets only. Related links and descendants do not expand this allowlist. */
export const YAHOO_AUCTION_CATEGORIES = Object.freeze([
  Object.freeze({
    id: "2084037425",
    path: ["23764", "23792", "2084037425"] as readonly string[],
    label: "オーディオ機器 > アンプ > 一般",
    categoryHint: "",
  }),
  Object.freeze({
    id: "2084024118",
    path: ["23764", "23772", "2084024118"] as readonly string[],
    label: "オーディオ機器 > CDデッキ > 一般",
    categoryHint: "SRC.DISC",
  }),
]);

export type YahooAuctionReviewStatus = "unverified" | "verified" | "denied";
export interface YahooAuctionReview {
  collection: YahooAuctionReviewStatus;
  redistribution: YahooAuctionReviewStatus;
  robots: YahooAuctionReviewStatus;
  accountBudget: YahooAuctionReviewStatus;
  sourceContract: YahooAuctionReviewStatus;
}

/** Change only with dated evidence in docs/yahoo-auctions.md; flags cannot approve these gates. */
export const YAHOO_AUCTION_REVIEW: Readonly<YahooAuctionReview> = Object.freeze({
  collection: "unverified",
  redistribution: "unverified",
  robots: "unverified",
  accountBudget: "unverified",
  sourceContract: "unverified",
});

export interface YahooAuctionControlEnv {
  readonly YAHOO_AUCTIONS_COLLECT_ENABLED?: string;
  readonly YAHOO_AUCTIONS_SEARCH_ENABLED?: string;
  readonly YAHOO_AUCTIONS_DISPLAY_ENABLED?: string;
}

export function yahooAuctionAccess(
  env: YahooAuctionControlEnv = {},
  review: Readonly<YahooAuctionReview> = YAHOO_AUCTION_REVIEW,
): { collect: boolean; search: boolean; display: boolean; blockers: string[] } {
  const verified = (key: keyof YahooAuctionReview) => review[key] === "verified";
  const servingAllowed =
    verified("redistribution") && verified("sourceContract") && verified("accountBudget");
  return {
    collect:
      env.YAHOO_AUCTIONS_COLLECT_ENABLED === "true" &&
      verified("collection") &&
      verified("robots") &&
      verified("accountBudget") &&
      verified("sourceContract"),
    search: env.YAHOO_AUCTIONS_SEARCH_ENABLED === "true" && servingAllowed,
    display: env.YAHOO_AUCTIONS_DISPLAY_ENABLED === "true" && servingAllowed,
    blockers: (Object.keys(YAHOO_AUCTION_REVIEW) as (keyof YahooAuctionReview)[]).filter(
      (key) => !verified(key),
    ),
  };
}

/** Provisional ceilings, NOT an allocation proven available in the shared Cloudflare account. */
export const YAHOO_AUCTION_PILOT_LIMITS = Object.freeze({
  retainedItems: 2_000,
  newItemsPerUtcDay: 500,
  sellerRequestsPerUtcDay: 500,
  listingPagesPerUtcDay: 100,
  minimumRequestDelayMs: 60_000,
  maxResponseBytes: 1_048_576,
  maxItemsPerPage: 100,
  doRequestsPerUtcDay: 5_000,
  publicRequestsPerUtcDay: 500,
  rowsReadPerUtcDay: 250_000,
  rowsWrittenPerUtcDay: 10_000,
  durationGbSecondsPerUtcDay: 1_000,
  storedBytes: 100_000_000,
  recoveryReserveRatio: 0.2,
});

export function yahooAuctionCategory(categoryId: string) {
  return YAHOO_AUCTION_CATEGORIES.find((category) => category.id === categoryId) ?? null;
}

/** Only vetted HTTPS detail paths; never accept login, alternate ports, credentials or fragments. */
export function yahooAuctionIdentity(
  value: unknown,
): { auctionId: string; sourceUrl: string } | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.origin !== YAHOO_AUCTION_ORIGIN ||
    url.username ||
    url.password ||
    url.hash ||
    /[\\\s]/u.test(value)
  ) {
    return null;
  }
  const match = url.pathname.match(/^\/jp\/auction\/([a-z][a-z0-9]{5,31})$/u);
  if (!match) return null;
  return { auctionId: match[1], sourceUrl: `${YAHOO_AUCTION_ORIGIN}/jp/auction/${match[1]}` };
}

/** Transport outcome, not auction state. Retry-After is a floor, not permission to resume a halt. */
export function yahooAuctionFetchPolicy(status: number | null, authenticationRequired = false) {
  if (authenticationRequired || status === 401 || status === 403) return "halt" as const;
  if (status === 429) return "backoff" as const;
  if (status !== null && status >= 200 && status < 300) return "parse" as const;
  if (status === 404 || status === 410) return "unavailable_unconfirmed" as const;
  return "retry" as const;
}
