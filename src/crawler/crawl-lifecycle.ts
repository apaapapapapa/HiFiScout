import type { ShopSyncStateRow } from "../db/types.js";

/** D1 columns owned by the Durable Object dispatch control plane. */
export type CrawlDispatchStateRow = ShopSyncStateRow & {
  dispatch_requested_at?: string | null;
  dispatch_token?: string | null;
  dispatch_last_sent_at?: string | null;
};

export type CrawlLifecyclePhase = "idle" | "dispatched" | "invalid";

export interface CrawlLifecycleSnapshot {
  phase: CrawlLifecyclePhase;
  requestedAt: string | null;
  dispatchToken: string | null;
  lastSentAt: string | null;
  invalidReason: "invalid_requested_at" | "partial_dispatch" | null;
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** Interprets the persisted Durable Object dispatch reservation as one explicit lifecycle. */
export function readCrawlLifecycle(
  state: CrawlDispatchStateRow | null | undefined,
): CrawlLifecycleSnapshot {
  if (!state?.dispatch_requested_at) {
    return {
      phase: "idle",
      requestedAt: null,
      dispatchToken: null,
      lastSentAt: null,
      invalidReason:
        state?.dispatch_token || state?.dispatch_last_sent_at ? "partial_dispatch" : null,
    };
  }

  const requestedAt = state.dispatch_requested_at;
  if (timestampMs(requestedAt) == null) {
    return {
      phase: "invalid",
      requestedAt,
      dispatchToken: state.dispatch_token || null,
      lastSentAt: state.dispatch_last_sent_at || null,
      invalidReason: "invalid_requested_at",
    };
  }

  if (!state.dispatch_token) {
    return {
      phase: "invalid",
      requestedAt,
      dispatchToken: null,
      lastSentAt: state.dispatch_last_sent_at || null,
      invalidReason: "partial_dispatch",
    };
  }

  return {
    phase: "dispatched",
    requestedAt,
    dispatchToken: state.dispatch_token,
    lastSentAt:
      timestampMs(state.dispatch_last_sent_at) == null
        ? requestedAt
        : state.dispatch_last_sent_at || requestedAt,
    invalidReason: null,
  };
}

/** A valid logical child remains reserved until its Durable Object execution terminates. */
export function hasDispatchReservation(
  state: CrawlDispatchStateRow | null | undefined,
): boolean {
  return readCrawlLifecycle(state).phase === "dispatched";
}

/** True when a dispatch has been quiet long enough to re-deliver the same immutable token. */
export function shouldRecoverDispatch(
  state: CrawlDispatchStateRow,
  now: Date,
  recoveryMinutes: number,
): boolean {
  const lifecycle = readCrawlLifecycle(state);
  if (lifecycle.phase !== "dispatched" || !lifecycle.lastSentAt) return false;
  const lastSentAtMs = timestampMs(lifecycle.lastSentAt);
  return (
    lastSentAtMs != null && now.getTime() - lastSentAtMs >= Math.max(1, recoveryMinutes) * 60_000
  );
}
