export interface AuctionSettingsInput {
  YAHOO_AUCTIONS_ENABLED?: string;
  YAHOO_AUCTIONS_SEARCH_ENABLED?: string;
  YAHOO_AUCTIONS_PUBLIC_ENABLED?: string;
  YAHOO_AUCTIONS_APPROVAL_REFERENCE?: string;
  YAHOO_AUCTIONS_SOURCE_VALIDATED?: string;
  YAHOO_AUCTIONS_BUDGET_REVIEWED?: string;
  YAHOO_AUCTIONS_CATEGORY_IDS?: string;
  YAHOO_AUCTIONS_MAX_ITEMS?: string;
  YAHOO_AUCTIONS_MAX_PAGES?: string;
  YAHOO_AUCTIONS_REQUEST_DELAY_MS?: string;
  YAHOO_AUCTIONS_DAILY_REQUESTS?: string;
  YAHOO_AUCTIONS_DAILY_ROWS_READ?: string;
  YAHOO_AUCTIONS_DAILY_ROWS_WRITTEN?: string;
}

export interface AuctionConfiguration {
  collectionEnabled: boolean;
  searchEnabled: boolean;
  publicEnabled: boolean;
  categoryIds: string[];
  maxItems: number;
  maxPages: number;
  requestDelayMs: number;
  dailyRequests: number;
  dailyRowsRead: number;
  dailyRowsWritten: number;
  blockers: string[];
}

/** Independent switches and explicit evidence gates; malformed settings fail closed. */
export function auctionConfiguration(env: AuctionSettingsInput): AuctionConfiguration {
  const blockers: string[] = [];
  function bounded(name: keyof AuctionSettingsInput, fallback: number, min: number, max: number) {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = /^\d+$/u.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      blockers.push(`invalid_configuration:${name}`);
      return fallback;
    }
    return value;
  }
  if (env.YAHOO_AUCTIONS_ENABLED !== "true") blockers.push("collection_disabled");
  const reference = env.YAHOO_AUCTIONS_APPROVAL_REFERENCE?.trim() ?? "";
  try {
    if (reference.length > 1000 || new URL(reference).protocol !== "https:") throw new Error();
  } catch {
    blockers.push("source_terms_unreviewed");
  }
  if (env.YAHOO_AUCTIONS_SOURCE_VALIDATED !== "true") blockers.push("source_fixture_unverified");
  if (env.YAHOO_AUCTIONS_BUDGET_REVIEWED !== "true") blockers.push("account_budget_unreviewed");
  const rawCategories =
    env.YAHOO_AUCTIONS_CATEGORY_IDS?.split(",").map((part) => part.trim()) ?? [];
  const categoryIds = [...new Set(rawCategories)];
  if (
    !categoryIds.length ||
    categoryIds.length > 16 ||
    categoryIds.some((id) => !/^\d{1,12}$/u.test(id))
  ) {
    blockers.push("category_scope_unreviewed");
  }
  const maxItems = bounded("YAHOO_AUCTIONS_MAX_ITEMS", 3000, 1, 20_000);
  const maxPages = bounded("YAHOO_AUCTIONS_MAX_PAGES", 5, 1, 20);
  const requestDelayMs = bounded("YAHOO_AUCTIONS_REQUEST_DELAY_MS", 30_000, 10_000, 600_000);
  const dailyRequests = bounded("YAHOO_AUCTIONS_DAILY_REQUESTS", 400, 1, 2000);
  const dailyRowsRead = bounded("YAHOO_AUCTIONS_DAILY_ROWS_READ", 500_000, 1000, 2_000_000);
  const dailyRowsWritten = bounded("YAHOO_AUCTIONS_DAILY_ROWS_WRITTEN", 15_000, 1000, 40_000);
  return {
    collectionEnabled: blockers.length === 0,
    searchEnabled: env.YAHOO_AUCTIONS_SEARCH_ENABLED === "true",
    publicEnabled: env.YAHOO_AUCTIONS_PUBLIC_ENABLED === "true",
    categoryIds: blockers.includes("category_scope_unreviewed") ? [] : categoryIds,
    maxItems,
    maxPages,
    requestDelayMs,
    dailyRequests,
    dailyRowsRead,
    dailyRowsWritten,
    blockers,
  };
}
