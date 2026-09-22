import { isRecord } from "../types.js";
import {
  canonicalProductQueryUrl,
  parseProductQuery,
  validateProductQuery,
} from "../api/product-query.js";

export const NOTIFICATION_LIMITS = {
  devices: 50,
  watches: 100,
  watchesPerDevice: 5,
  queryBytes: 2000,
  batch: 20,
  rulesPerAlarm: 5,
  pushesPerAlarm: 3,
  intervalMs: 15 * 60_000,
  continuationMs: 60_000,
  overlapMs: 60 * 60_000,
  retentionMs: 7 * 86_400_000,
  deviceExpiryMs: 90 * 86_400_000,
  statementsPerDay: 2000,
  readsPerDay: 200_000,
  pushesPerDay: 500,
  ledgerLimit: 10_000,
} as const;

export interface PushAddress {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface WatchInput {
  id: string;
  query: string;
  newListings: boolean;
  priceDrops: boolean;
}
export interface Watch extends WatchInput {
  device: string;
  createdAt: number;
}
export interface NotificationEvent {
  id: string;
  listingId: number;
  at: number;
  kind: "new" | "drop";
  price: number | null;
  title: string;
  key: string;
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_base64url");
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export async function digest(value: string): Promise<string> {
  return base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Push capabilities are accepted only at supported providers; redirects are never followed. */
export function allowedPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 2048 &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      ((url.hostname === "fcm.googleapis.com" && url.pathname.startsWith("/fcm/send/")) ||
        (url.hostname === "updates.push.services.mozilla.com" &&
          url.pathname.startsWith("/wpush/v2/")) ||
        (url.hostname === "web.push.apple.com" && url.pathname.startsWith("/Q")) ||
        (/^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname) && url.pathname.startsWith("/w/")))
    );
  } catch {
    return false;
  }
}
export function parsePushAddress(value: unknown): PushAddress | null {
  if (
    !isRecord(value) ||
    !isRecord(value.keys) ||
    typeof value.endpoint !== "string" ||
    !allowedPushEndpoint(value.endpoint) ||
    typeof value.keys.p256dh !== "string" ||
    typeof value.keys.auth !== "string"
  )
    return null;
  try {
    const key = decodeBase64Url(value.keys.p256dh);
    if (
      value.keys.p256dh.length !== 87 ||
      key.length !== 65 ||
      key[0] !== 4 ||
      value.keys.auth.length !== 22 ||
      decodeBase64Url(value.keys.auth).length !== 16
    )
      return null;
    return { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
  } catch {
    return null;
  }
}
export function parseWatch(value: unknown): WatchInput | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(value.id) ||
    typeof value.query !== "string" ||
    value.query.length > NOTIFICATION_LIMITS.queryBytes ||
    typeof value.newListings !== "boolean" ||
    typeof value.priceDrops !== "boolean" ||
    (!value.newListings && !value.priceDrops)
  )
    return null;
  const url = new URL("https://notification.invalid/api/product-search");
  url.search = value.query;
  for (const key of ["cursor", "offset", "limit", "includeTotal", "view", "compare"])
    if (url.searchParams.has(key)) return null;
  if (validateProductQuery(url)) return null;
  const parsed = parseProductQuery(url);
  if (parsed.minPrice !== null && parsed.maxPrice !== null && parsed.minPrice > parsed.maxPrice)
    return null;
  // Notifications concern purchasable offers. Search order has no bearing on membership.
  const canonical = canonicalProductQueryUrl(url, {
    ...parsed,
    inStock: true,
    explicitSort: false,
  });
  canonical.searchParams.delete("limit");
  return {
    id: value.id,
    query: canonical.searchParams.toString(),
    newListings: value.newListings,
    priceDrops: value.priceDrops,
  };
}
export function watchAccepts(watch: Watch, event: NotificationEvent): boolean {
  return (
    event.at >= watch.createdAt && (event.kind === "new" ? watch.newListings : watch.priceDrops)
  );
}
