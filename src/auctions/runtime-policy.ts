import { nextCrawlAllowedAt } from "../crawler/crawl-window.js";
import { YAHOO_AUCTION_PILOT_LIMITS as limits } from "./yahoo/policy.js";

export const AUCTION_FRESH_MS = 2 * 60 * 60_000;
export const AUCTION_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const AUCTION_MAX_ATTEMPTS = 4;
export const AUCTION_PAGE_LIMIT = 3;
export type AuctionWorkKind = "discover" | "confirm";
export interface AuctionTask {
  id: string;
  kind: AuctionWorkKind;
  categoryId: string;
  auctionId: string | null;
  page: number;
  due: number;
  attempts: number;
  sequence: number | null;
  endChecks?: number;
}
export interface AuctionCharge {
  requests: number;
  sellerRequests: number;
  pages: number;
  newItems: number;
  reads: number;
  writes: number;
  durationGbSeconds: number;
}
export interface AuctionRuntimeState {
  version: 1;
  paused: boolean;
  publicPaused: boolean;
  generation: number;
  sequence: number;
  nextFetchAt: number;
  backoffUntil: number;
  halt: string | null;
  throttleCount: number;
  lastKind: AuctionWorkKind;
  utcDay: number;
  reserved: AuctionCharge;
  coverage: "partial" | "unknown";
  lastSuccessAt: string | null;
  lastFailure: string | null;
  categories: string[];
  catalogCursor: string;
  robots: { text: string; observedAt: number; delayMs: number } | null;
}
export const emptyAuctionCharge = (): AuctionCharge => ({
  requests: 0,
  sellerRequests: 0,
  pages: 0,
  newItems: 0,
  reads: 0,
  writes: 0,
  durationGbSeconds: 0,
});
export function initialAuctionRuntime(now: number): AuctionRuntimeState {
  return {
    version: 1,
    paused: true,
    publicPaused: true,
    generation: 1,
    sequence: 0,
    nextFetchAt: 0,
    backoffUntil: 0,
    halt: null,
    throttleCount: 0,
    lastKind: "confirm",
    utcDay: Math.floor(now / 86_400_000),
    reserved: emptyAuctionCharge(),
    coverage: "unknown",
    lastSuccessAt: null,
    lastFailure: null,
    categories: [],
    catalogCursor: "",
    robots: null,
  };
}
/** Conservative reservations, not measured billing. Failed/interrupted work is never refunded. */
export function reserveAuctionBudget(
  state: AuctionRuntimeState,
  charge: AuctionCharge,
  now: number,
  recovery = false,
): AuctionRuntimeState | null {
  const day = Math.floor(now / 86_400_000);
  // A clock rollback cannot resurrect a previously exhausted day.
  const used = day > state.utcDay ? emptyAuctionCharge() : state.reserved;
  const maxima: AuctionCharge = {
    requests: limits.doRequestsPerUtcDay,
    sellerRequests: limits.sellerRequestsPerUtcDay,
    pages: limits.listingPagesPerUtcDay,
    newItems: limits.newItemsPerUtcDay,
    reads: limits.rowsReadPerUtcDay,
    writes: limits.rowsWrittenPerUtcDay,
    durationGbSeconds: limits.durationGbSecondsPerUtcDay,
  };
  const reserved = { ...used };
  for (const key of Object.keys(maxima) as (keyof AuctionCharge)[]) {
    if (!Number.isFinite(charge[key]) || charge[key] < 0) return null;
    reserved[key] += charge[key];
    if (reserved[key] > maxima[key] * (recovery ? 1 : 1 - limits.recoveryReserveRatio)) return null;
  }
  return { ...state, reserved, utcDay: Math.max(day, state.utcDay) };
}
export function auctionFetchDue(state: AuctionRuntimeState, due: number, now: number): number {
  return nextCrawlAllowedAt(Math.max(due, now, state.nextFetchAt, state.backoffUntil));
}
export function auctionRetryAt(attempts: number, now: number, retryAfter: string | null): number {
  const seconds = retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
  const date = retryAfter && !/^\d+$/u.test(retryAfter) ? Date.parse(retryAfter) : NaN;
  return nextCrawlAllowedAt(
    Math.max(
      now + Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(attempts, 8)),
      now + (Number.isFinite(seconds) ? seconds : 0),
      Number.isFinite(date) ? date : 0,
    ),
  );
}
