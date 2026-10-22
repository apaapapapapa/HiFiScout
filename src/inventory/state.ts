import type { StockStatus } from "../catalog/types.js";

export type InventoryEvidence =
  | "not_checked"
  | "in_stock"
  | "sold_out"
  | "missing"
  | "unknown"
  | "deferred";
export interface InventoryStateInput {
  stockStatus: StockStatus;
  lastSeenAt: string;
  lastConfirmedAvailableAt: string | null;
  lastCheckedAt: string | null;
  failureCount: number;
  latest: InventoryEvidence;
  observedAt: string;
  unknownBefore?: string;
  failureThreshold: number;
}
export interface InventoryDecision {
  action: "keep" | "mark_unknown" | "deactivate_confirmed" | "defer";
  reason: string;
  stockStatus: StockStatus;
  failureCount: number;
  lastConfirmedAvailableAt: string | null;
}

/** No I/O: attempt freshness, positive evidence and repeated absence are separate facts. */
export function decideInventoryState(input: InventoryStateInput): InventoryDecision {
  const result: InventoryDecision = {
    action: "keep",
    reason: "unchanged",
    stockStatus: input.stockStatus,
    failureCount: input.failureCount,
    lastConfirmedAvailableAt: input.lastConfirmedAvailableAt,
  };
  const at = Date.parse(input.observedAt);
  if (!Number.isFinite(at))
    return { ...result, action: "defer", reason: "invalid_observation_time" };
  if (input.latest === "deferred")
    return { ...result, action: "defer", reason: "verification_unavailable" };
  if (input.latest === "not_checked") {
    const before = Date.parse(input.unknownBefore ?? "");
    const seen = Date.parse(input.lastSeenAt);
    if (!Number.isFinite(before) || !Number.isFinite(seen))
      return { ...result, action: "defer", reason: "missing_freshness_evidence" };
    if (input.stockStatus !== "in_stock" || seen >= before)
      return { ...result, reason: "not_stale_in_stock" };
    const confirmed = Date.parse(input.lastConfirmedAvailableAt ?? "");
    if (Number.isFinite(confirmed) && confirmed >= before)
      return { ...result, reason: "recent_confirmed_available" };
    return {
      ...result,
      action: "mark_unknown",
      stockStatus: "unknown",
      reason: "availability_evidence_expired",
    };
  }
  if (
    Number.isFinite(Date.parse(input.lastCheckedAt ?? "")) &&
    at <= Date.parse(input.lastCheckedAt!)
  )
    return { ...result, action: "defer", reason: "duplicate_or_older_observation" };
  if (input.latest === "in_stock")
    return {
      ...result,
      reason: "confirmed_available",
      stockStatus: "in_stock",
      failureCount: 0,
      lastConfirmedAvailableAt: input.observedAt,
    };
  if (input.latest === "unknown")
    return {
      ...result,
      action: input.stockStatus === "in_stock" ? "mark_unknown" : "keep",
      stockStatus: input.stockStatus === "sold_out" ? "sold_out" : "unknown",
      failureCount: 0,
      reason: "ambiguous_breaks_confirmation_sequence",
    };
  // A normal listing sighting after the prior check breaks the old absence sequence. It does
  // not claim a new detail availability confirmation and never rewrites that timestamp.
  const checked = Date.parse(input.lastCheckedAt ?? "");
  const seen = Date.parse(input.lastSeenAt);
  const previous =
    !Number.isFinite(checked) || (Number.isFinite(seen) && seen > checked)
      ? 0
      : Math.max(0, input.failureCount);
  const failureCount = previous + 1;
  const threshold = Math.max(2, input.failureThreshold);
  const deactivate = failureCount >= threshold;
  return {
    ...result,
    action: deactivate ? "deactivate_confirmed" : "keep",
    reason: deactivate ? "repeated_unavailable_evidence" : "awaiting_unavailable_confirmation",
    failureCount,
    stockStatus: deactivate || input.latest === "sold_out" ? "sold_out" : input.stockStatus,
  };
}
