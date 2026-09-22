import type {
  AuctionLiveFacts,
  AuctionObservation,
  AuctionObservationStamp,
  AuctionSnapshot,
} from "./types.js";

/** Accept explicit timezone/calendar dates only; never guess a year or interpret a countdown. */
export function auctionInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u,
  );
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 2000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  const zone = match[7];
  if (zone !== "Z") {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function auctionObservationStamp(value: unknown): AuctionObservationStamp | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { generation, sequence } = record;
  const observedAt = auctionInstant(record.observedAt);
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !observedAt
  )
    return null;
  return { generation, sequence, observedAt };
}

export function emptyAuctionLiveFacts(): AuctionLiveFacts {
  return {
    currentPrice: null,
    buyNowPrice: null,
    bidCount: null,
    scheduledEndAt: null,
    startedAt: null,
    sourceState: null,
    outcome: null,
    shipping: null,
  };
}

function newerStamp(next: AuctionObservationStamp, previous: AuctionObservationStamp): boolean {
  return (
    next.generation > previous.generation ||
    (next.generation === previous.generation && next.sequence > previous.sequence)
  );
}

export type AuctionApplyResult =
  | { status: "applied"; snapshot: AuctionSnapshot }
  | {
      status: "stale" | "duplicate" | "identity_mismatch" | "reopening_unconfirmed" | "invalid";
      snapshot: AuctionSnapshot | null;
    };

/** Merge only actually observed fields, preserving their original evidence times. */
export function applyAuctionObservation(
  previous: AuctionSnapshot | null,
  next: AuctionObservation,
): AuctionApplyResult {
  const stamp = auctionObservationStamp(next.stamp);
  if (
    !stamp ||
    Object.values(next.live).some((fact) => fact !== null && fact.observedAt !== stamp.observedAt)
  ) {
    return { status: "invalid", snapshot: previous };
  }
  if (!previous) return { status: "applied", snapshot: { ...next, stamp, cycle: 1 } };
  if (
    previous.source !== next.source ||
    previous.auctionId !== next.auctionId ||
    previous.sourceUrl !== next.sourceUrl
  ) {
    return { status: "identity_mismatch", snapshot: previous };
  }
  if (
    stamp.generation === previous.stamp.generation &&
    stamp.sequence === previous.stamp.sequence
  ) {
    return { status: "duplicate", snapshot: previous };
  }
  if (!newerStamp(stamp, previous.stamp) || stamp.observedAt < previous.stamp.observedAt) {
    return { status: "stale", snapshot: previous };
  }
  const reopening =
    previous.live.sourceState?.value === "ended" && next.live.sourceState?.value === "open";
  if (reopening) {
    const start = next.live.startedAt?.value;
    const confirmedEnd = previous.live.sourceState?.observedAt;
    if (
      !start ||
      !confirmedEnd ||
      !auctionInstant(start) ||
      start <= confirmedEnd ||
      start > stamp.observedAt
    ) {
      return { status: "reopening_unconfirmed", snapshot: previous };
    }
    // Explicit later start is a new cycle. Never carry the previous cycle's price/outcome forward.
    return { status: "applied", snapshot: { ...next, stamp, cycle: previous.cycle + 1 } };
  }
  const preserveEnd =
    previous.live.sourceState?.value === "ended" && next.live.sourceState?.value !== "ended";
  const live: AuctionLiveFacts = {
    currentPrice: next.live.currentPrice ?? previous.live.currentPrice,
    buyNowPrice: next.live.buyNowPrice ?? previous.live.buyNowPrice,
    bidCount: next.live.bidCount ?? previous.live.bidCount,
    scheduledEndAt: next.live.scheduledEndAt ?? previous.live.scheduledEndAt,
    startedAt: next.live.startedAt ?? previous.live.startedAt,
    sourceState: preserveEnd
      ? previous.live.sourceState
      : (next.live.sourceState ?? previous.live.sourceState),
    outcome: next.live.outcome ?? previous.live.outcome,
    shipping: next.live.shipping ?? previous.live.shipping,
  };
  return { status: "applied", snapshot: { ...next, stamp, live, cycle: previous.cycle } };
}

/** Passing time never mutates source state or proves a sale. */
export function auctionPresentation(snapshot: AuctionSnapshot, now: string, maxAgeMs: number) {
  const instant = auctionInstant(now);
  if (!instant || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0)
    throw new Error("Invalid auction freshness parameters");
  const state = snapshot.live.sourceState;
  const end = snapshot.live.scheduledEndAt?.value;
  const age = state ? Date.parse(instant) - Date.parse(state.observedAt) : null;
  const freshness = age === null || age < 0 ? "unknown" : age > maxAgeMs ? "stale" : "fresh";
  const phase =
    state?.value === "ended" || state?.value === "unavailable"
      ? state.value
      : end && end <= instant
        ? "end_check_pending"
        : (state?.value ?? "unknown");
  return {
    phase,
    freshness,
    sourceState: state?.value ?? "unknown",
    outcome: snapshot.live.outcome?.value ?? "unknown",
  };
}
