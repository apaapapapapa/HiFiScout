import type { AuctionAdminStatus } from "../api/admin-auction-contracts.js";
import { nextCrawlAllowedAt } from "../crawler/crawl-window.js";
import { AuctionStore } from "./storage.js";
import { emptyAuctionCharge } from "./runtime-policy.js";
import {
  yahooAuctionAccess,
  YAHOO_AUCTION_CATEGORIES,
  YAHOO_AUCTION_PILOT_LIMITS,
} from "./yahoo/policy.js";
/** Bounded by the 2,000 retained-item/task/key ceiling, without D1 or per-shop fan-out. */
export async function auctionAdminStatus(
  store: AuctionStore,
  env: Env,
  now: number,
): Promise<AuctionAdminStatus> {
  const { robots: _robots, ...state } = store.runtime(now);
  const tasks = store.sql<{ total: number; exhausted: number; confirmations: number }>(
    "control",
    "SELECT count(*) total,coalesce(sum(due=?),0) exhausted,coalesce(sum(kind='confirm'),0) confirmations FROM auction_tasks",
    Number.MAX_SAFE_INTEGER,
  )[0];
  const catalog = store.sql<{ next_due: number; error: string | null }>(
    "catalog",
    "SELECT next_due,error FROM auction_catalog_schedule WHERE id=1",
  )[0];
  const nextAllowed = nextCrawlAllowedAt(now);
  return {
    observedAt: new Date(now).toISOString(),
    state: { ...state, reserved: { ...emptyAuctionCharge(), ...state.reserved } },
    access: yahooAuctionAccess(env),
    limits: YAHOO_AUCTION_PILOT_LIMITS,
    categories: YAHOO_AUCTION_CATEGORIES,
    nextAlarm: await store.getAlarm(),
    retainedItems: store.sql<{ n: number }>("control", "SELECT count(*) n FROM auction_items")[0].n,
    pendingTasks: tasks.total - tasks.exhausted,
    exhaustedTasks: tasks.exhausted,
    confirmationTasks: tasks.confirmations,
    endCheckPending: store.sql<{ n: number }>(
      "control",
      "SELECT count(*) n FROM auction_live_state WHERE end_at<=? AND (state IS NULL OR state NOT IN ('ended','unavailable'))",
      new Date(now).toISOString(),
    )[0].n,
    catalogPendingKeys: store.sql<{ n: number }>(
      "catalog",
      "SELECT count(*) n FROM auction_catalog_replays",
    )[0].n,
    catalogNext: catalog?.next_due ?? null,
    catalogError: catalog?.error ?? null,
    storageBytes: store.storage.sql.databaseSize,
    quietHours: nextAllowed > now,
    quietEndsAt: nextAllowed > now ? new Date(nextAllowed).toISOString() : null,
    productionUsage: null,
    reservationKind: "conservative_upper_bound",
  };
}
