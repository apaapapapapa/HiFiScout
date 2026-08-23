import { crawlDispatchToken } from "../db/shop-state-repository.js";
import type { ShopSyncStateRow } from "../db/types.js";

/** Queue/execution columns added after the original shop-state row vocabulary. */
export type CrawlLifecycleRow = ShopSyncStateRow & {
  queued_token?: string | null;
  queued_last_sent_at?: string | null;
  crawl_lease_token?: string | null;
  crawl_lease_until?: string | null;
};

export type CrawlLifecyclePhase = "idle" | "queued" | "executing" | "invalid";

export type CrawlLifecycleInvalidReason =
  | "invalid_requested_at"
  | "orphaned_execution_lease"
  | "partial_execution_lease"
  | "invalid_execution_lease";

export interface CrawlLifecycleSnapshot {
  phase: CrawlLifecyclePhase;
  requestedAt: string | null;
  dispatchToken: string | null;
  lastSentAt: string | null;
  crawlLeaseToken: string | null;
  crawlLeaseUntil: string | null;
  invalidReason: CrawlLifecycleInvalidReason | null;
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Interprets the nullable persistence columns as one explicit crawler lifecycle.
 *
 * `queued_at` owns the logical child until the consumer or DLQ releases it. An unexpired crawl
 * lease upgrades that queued child to `executing`; an expired lease makes it `queued` again so the
 * same dispatch can be reclaimed. Invalid combinations are surfaced instead of being silently
 * treated as another lifecycle phase.
 */
export function readCrawlLifecycle(
  state: CrawlLifecycleRow | null | undefined,
  now = new Date(),
): CrawlLifecycleSnapshot {
  if (!state) {
    return {
      phase: "idle",
      requestedAt: null,
      dispatchToken: null,
      lastSentAt: null,
      crawlLeaseToken: null,
      crawlLeaseUntil: null,
      invalidReason: null,
    };
  }

  const requestedAt = state.queued_at;
  const hasLeaseToken = Boolean(state.crawl_lease_token);
  const hasLeaseUntil = Boolean(state.crawl_lease_until);

  if (!requestedAt) {
    if (hasLeaseToken || hasLeaseUntil) {
      return {
        phase: "invalid",
        requestedAt: null,
        dispatchToken: null,
        lastSentAt: null,
        crawlLeaseToken: state.crawl_lease_token || null,
        crawlLeaseUntil: state.crawl_lease_until || null,
        invalidReason: "orphaned_execution_lease",
      };
    }
    return {
      phase: "idle",
      requestedAt: null,
      dispatchToken: null,
      lastSentAt: null,
      crawlLeaseToken: null,
      crawlLeaseUntil: null,
      invalidReason: null,
    };
  }

  if (timestampMs(requestedAt) == null) {
    return {
      phase: "invalid",
      requestedAt,
      dispatchToken: state.queued_token || null,
      lastSentAt: state.queued_last_sent_at || null,
      crawlLeaseToken: state.crawl_lease_token || null,
      crawlLeaseUntil: state.crawl_lease_until || null,
      invalidReason: "invalid_requested_at",
    };
  }

  if (hasLeaseToken !== hasLeaseUntil) {
    return {
      phase: "invalid",
      requestedAt,
      dispatchToken: state.queued_token || crawlDispatchToken(state.shop_key, requestedAt),
      lastSentAt: state.queued_last_sent_at || requestedAt,
      crawlLeaseToken: state.crawl_lease_token || null,
      crawlLeaseUntil: state.crawl_lease_until || null,
      invalidReason: "partial_execution_lease",
    };
  }

  const dispatchToken = state.queued_token || crawlDispatchToken(state.shop_key, requestedAt);
  const lastSentAt =
    timestampMs(state.queued_last_sent_at) == null
      ? requestedAt
      : state.queued_last_sent_at || requestedAt;

  if (!hasLeaseToken) {
    return {
      phase: "queued",
      requestedAt,
      dispatchToken,
      lastSentAt,
      crawlLeaseToken: null,
      crawlLeaseUntil: null,
      invalidReason: null,
    };
  }

  const leaseUntilMs = timestampMs(state.crawl_lease_until);
  if (leaseUntilMs == null) {
    return {
      phase: "invalid",
      requestedAt,
      dispatchToken,
      lastSentAt,
      crawlLeaseToken: state.crawl_lease_token || null,
      crawlLeaseUntil: state.crawl_lease_until || null,
      invalidReason: "invalid_execution_lease",
    };
  }

  return {
    phase: leaseUntilMs > now.getTime() ? "executing" : "queued",
    requestedAt,
    dispatchToken,
    lastSentAt,
    crawlLeaseToken: state.crawl_lease_token || null,
    crawlLeaseUntil: state.crawl_lease_until || null,
    invalidReason: null,
  };
}

/** A valid queued child remains reserved regardless of how long it has waited in Cloudflare Queue. */
export function hasDispatchReservation(
  state: Partial<Pick<ShopSyncStateRow, "queued_at">> | null | undefined,
): boolean {
  return timestampMs(state?.queued_at) != null;
}

/** True only when the same logical child is queued, not executing, and its resend window elapsed. */
export function shouldRecoverDispatch(
  state: CrawlLifecycleRow,
  now: Date,
  recoveryMinutes: number,
): boolean {
  const lifecycle = readCrawlLifecycle(state, now);
  if (lifecycle.phase !== "queued" || !lifecycle.lastSentAt) return false;
  const lastSentAtMs = timestampMs(lifecycle.lastSentAt);
  return (
    lastSentAtMs != null && now.getTime() - lastSentAtMs >= Math.max(1, recoveryMinutes) * 60_000
  );
}

/** Whether a queue delivery still owns the currently reserved logical child. */
export function matchesDispatchReservation(
  state: CrawlLifecycleRow | null,
  shopKey: string,
  requestedAt: string,
): boolean {
  if (!state) return false;
  const dispatchToken = crawlDispatchToken(shopKey, requestedAt);
  return (
    state.queued_token === dispatchToken || (!state.queued_token && state.queued_at === requestedAt)
  );
}

/** Retry delay for a duplicate delivery while the owning child is still executing. */
export function retryAfterExecutionLeaseSeconds(
  state: CrawlLifecycleRow | null,
  now: Date,
  safetySeconds: number,
): number | null {
  const lifecycle = readCrawlLifecycle(state, now);
  if (lifecycle.phase !== "executing" || !lifecycle.crawlLeaseUntil) return null;
  const leaseUntilMs = timestampMs(lifecycle.crawlLeaseUntil);
  if (leaseUntilMs == null) return null;
  return Math.max(1, Math.ceil((leaseUntilMs - now.getTime()) / 1000) + safetySeconds);
}
