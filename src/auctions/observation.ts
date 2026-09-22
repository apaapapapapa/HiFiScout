import type { AuctionDisplayState, AuctionObservation } from "../api/auction-contracts.js";
import { yahooAuctionIdentity } from "./yahoo/policy.js";

const OBSERVATION_KEYS = new Set([
  "source",
  "auctionId",
  "sourceUrl",
  "title",
  "rawManufacturer",
  "rawModel",
  "sourceCategoryId",
  "rawCategoryPath",
  "condition",
  "saleSubject",
  "saleUnit",
  "currentPriceYen",
  "buyNowPriceStatus",
  "buyNowPriceYen",
  "bidCount",
  "taxStatus",
  "shipping",
  "sourceStatus",
  "sourceStartedAt",
  "scheduledEndAt",
  "requestedAt",
  "observedAt",
]);

/** Reuse the reviewed source identity policy; tracking parameters are not auction identity. */
export function canonicalAuctionUrl(value: unknown, expectedId?: string): string | null {
  const identity = yahooAuctionIdentity(value);
  return identity && (expectedId === undefined || identity.auctionId === expectedId)
    ? identity.sourceUrl
    : null;
}

export function isAuctionInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function nullableInstant(value: unknown): value is string | null {
  return value === null || isAuctionInstant(value);
}

function boundedText(value: unknown, max: number, required = false): value is string {
  return typeof value === "string" && value.length <= max && (!required || value.trim().length > 0);
}

function nullableInteger(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 1_000_000_000_000)
  );
}

function member<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
  return choices.find((choice) => choice === value);
}

/** Validate at every persistence boundary, including replay/import; unknown is never zero. */
export function parseAuctionObservation(value: unknown): AuctionObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !OBSERVATION_KEYS.has(key))) return null;
  const { sourceStartedAt, scheduledEndAt, requestedAt, observedAt } = input;
  if (
    !nullableInstant(sourceStartedAt) ||
    !nullableInstant(scheduledEndAt) ||
    !isAuctionInstant(requestedAt) ||
    !isAuctionInstant(observedAt)
  ) {
    return null;
  }
  const id = typeof input.auctionId === "string" ? input.auctionId : null;
  const sourceUrl = id ? canonicalAuctionUrl(input.sourceUrl, id) : null;
  const buyNowPriceStatus = member(input.buyNowPriceStatus, ["set", "none", "unknown"] as const);
  const condition = member(input.condition, ["new", "used", "junk", "unknown"] as const);
  const saleSubject = member(input.saleSubject, [
    "product",
    "accessory",
    "parts",
    "empty_box",
    "bundle",
    "unknown",
  ] as const);
  const saleUnit = member(input.saleUnit, ["single", "pair", "set", "unknown"] as const);
  const taxStatus = member(input.taxStatus, ["included", "excluded", "unknown"] as const);
  const shipping = member(input.shipping, ["free", "additional", "collect", "unknown"] as const);
  const sourceStatus = member(input.sourceStatus, [
    "active",
    "ended",
    "unavailable",
    "unknown",
  ] as const);
  if (
    input.source !== "yahoo-auctions" ||
    !id ||
    !sourceUrl ||
    !boundedText(input.title, 500, true) ||
    !boundedText(input.rawManufacturer, 160) ||
    !boundedText(input.rawModel, 300) ||
    !boundedText(input.rawCategoryPath, 500) ||
    typeof input.sourceCategoryId !== "string" ||
    !/^\d{1,12}$/u.test(input.sourceCategoryId) ||
    !condition ||
    !saleSubject ||
    !saleUnit ||
    !taxStatus ||
    !shipping ||
    !sourceStatus ||
    !nullableInteger(input.currentPriceYen) ||
    !nullableInteger(input.buyNowPriceYen) ||
    !buyNowPriceStatus ||
    (buyNowPriceStatus === "set") !== (input.buyNowPriceYen !== null) ||
    !nullableInteger(input.bidCount) ||
    observedAt < requestedAt ||
    (sourceStartedAt !== null && sourceStartedAt > observedAt) ||
    (sourceStartedAt !== null && scheduledEndAt !== null && scheduledEndAt < sourceStartedAt)
  ) {
    return null;
  }
  return {
    source: "yahoo-auctions",
    auctionId: id,
    sourceUrl,
    title: input.title,
    rawManufacturer: input.rawManufacturer,
    rawModel: input.rawModel,
    sourceCategoryId: input.sourceCategoryId,
    rawCategoryPath: input.rawCategoryPath,
    condition,
    saleSubject,
    saleUnit,
    currentPriceYen: input.currentPriceYen,
    buyNowPriceStatus,
    buyNowPriceYen: input.buyNowPriceYen,
    bidCount: input.bidCount,
    taxStatus,
    shipping,
    sourceStatus,
    sourceStartedAt,
    scheduledEndAt,
    requestedAt,
    observedAt,
  };
}

/** A scheduled end is not evidence that bidding ended or that a sale completed. */
export function auctionDisplayState(
  item: AuctionObservation,
  now: number,
  staleAfterMs = 2 * 60 * 60_000,
): AuctionDisplayState {
  const observedAt = Date.parse(item.observedAt);
  if (!Number.isFinite(now) || !Number.isFinite(observedAt) || now < observedAt) return "unknown";
  if (item.sourceStatus === "ended" || item.sourceStatus === "unavailable")
    return item.sourceStatus;
  if (item.scheduledEndAt !== null && Date.parse(item.scheduledEndAt) <= now) {
    return "end_confirmation_pending";
  }
  if (item.sourceStatus !== "active") return "unknown";
  return now - observedAt > staleAfterMs ? "stale" : "active";
}

/** Ordering uses request start, not delayed delivery time. Terminal state needs proven relisting. */
export function acceptsAuctionObservation(
  previous: AuctionObservation,
  next: AuctionObservation,
): boolean {
  if (previous.auctionId !== next.auctionId || next.requestedAt <= previous.requestedAt)
    return false;
  if (previous.sourceStatus === "ended" && next.sourceStatus !== "ended") {
    if (next.sourceStatus !== "active") return false;
    return (
      previous.sourceStartedAt !== null &&
      next.sourceStartedAt !== null &&
      next.sourceStartedAt > previous.sourceStartedAt &&
      next.sourceStartedAt > previous.observedAt &&
      next.sourceStartedAt <= next.observedAt
    );
  }
  return true;
}
