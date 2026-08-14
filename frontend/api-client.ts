/**
 * `/api` access plus the guards that turn an untrusted JSON response into a typed payload.
 *
 * Shared TypeScript contracts describe what the Worker *should* send; these guards are what the
 * browser actually trusts, so they stay even though both sides now compile against the same
 * types. Each one validates only the collections the caller iterates.
 */

import type { MetaResponse } from "../src/api/contracts.js";
import type { ProductHistoryResponse, ProductsResponse } from "./types.js";

/** Matches the Worker's own `cache-control: public, max-age=30` on these endpoints. */
const CACHE_TTL_MS = 30_000;

interface CachedResponse {
  data: unknown;
  expiresAt: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isMetaResponse(value: unknown): value is MetaResponse {
  return isRecord(value) && Array.isArray(value.shops) && Array.isArray(value.manufacturers);
}

export function isProductsResponse(value: unknown): value is ProductsResponse {
  return isRecord(value) && Array.isArray(value.items);
}

export function isProductHistoryResponse(value: unknown): value is ProductHistoryResponse {
  return isRecord(value) && isRecord(value.product) && Array.isArray(value.history);
}

/**
 * Short-lived in-memory response cache.
 *
 * Paging back and forth re-requests the same URLs, and the entries are per-tab and expire, so a
 * stale price is bounded by {@link CACHE_TTL_MS} rather than by the session.
 */
export function createApiClient(fetchImpl: typeof fetch = fetch, ttlMs = CACHE_TTL_MS) {
  const cache = new Map<string, CachedResponse>();

  return {
    async fetchJson(url: string, { signal }: { signal?: AbortSignal } = {}): Promise<unknown> {
      const cached = cache.get(url);
      if (cached && cached.expiresAt > Date.now()) return cached.data;
      if (cached) cache.delete(url);

      const response = await fetchImpl(url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: unknown = await response.json();
      cache.set(url, { data, expiresAt: Date.now() + ttlMs });
      return data;
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
