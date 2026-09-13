/** Response construction and edge-cache wrappers shared by read endpoints. */

/** `no-store` by default: an endpoint opts into caching by passing its own `cache-control`. */
export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

/** The caller is over its limit. */
export function rateLimitedResponse(): Response {
  return json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
}

/**
 * The rate limiter could not decide, so the request is refused rather than served unmetered.
 *
 * This is deliberately distinct from 429: nothing is wrong with the caller, the protection is
 * missing. A read that an existing cache entry can answer is served from that entry instead; what
 * must not happen is a cache miss quietly falling through to D1 with no limit in force.
 */
export function rateLimiterUnavailableResponse(): Response {
  return json(
    { error: "rate_limiter_unavailable" },
    { status: 503, headers: { "retry-after": "30" } },
  );
}

export interface CachedReadOptions {
  /** Serve only from an existing cache entry; a miss must not reach D1. */
  cacheOnly?: boolean;
  /** Response for a `cacheOnly` miss. Defaults to the JSON 503. */
  unavailableResponse?: () => Response;
}

/**
 * Serves a successful public read through Cloudflare's edge cache.
 *
 * Error responses are deliberately not inserted: a transient lookup miss, validation failure, or
 * rate-limit response must never become the cached representation of a public URL.
 */
export async function cachedResponse(
  request: Request,
  ctx: ExecutionContext,
  load: () => Response | Promise<Response>,
  {
    cacheOnly = false,
    unavailableResponse = rateLimiterUnavailableResponse,
  }: CachedReadOptions = {},
): Promise<Response> {
  const cache =
    typeof caches === "undefined"
      ? null
      : (caches as CacheStorage & { readonly default: Cache }).default;
  const cached = cache ? await cache.match(request) : undefined;
  if (cached) return cached;
  if (cacheOnly) return unavailableResponse();
  const response = await load();
  if (cache && response.ok) ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

/**
 * Serves `load()` through the Cloudflare edge cache.
 *
 * The cache write is deferred with `waitUntil` so a slow `cache.put` never delays the response,
 * and `caches` is feature-detected because it is absent outside the Workers runtime (tests).
 */
export async function cachedJson(
  request: Request,
  ctx: ExecutionContext,
  ttlSeconds: number,
  load: () => unknown | Promise<unknown>,
  options: CachedReadOptions = {},
): Promise<Response> {
  const cacheControl = `public, max-age=${ttlSeconds}`;
  return cachedResponse(
    request,
    ctx,
    async () => json(await load(), { headers: { "cache-control": cacheControl } }),
    options,
  );
}

/** Atom/XML sibling of {@link cachedJson}; keeps XML out of the JSON serializer. */
export async function cachedAtom(
  request: Request,
  ctx: ExecutionContext,
  ttlSeconds: number,
  load: () => string | Promise<string>,
  options: CachedReadOptions = {},
): Promise<Response> {
  const cacheControl = `public, max-age=${ttlSeconds}`;
  return cachedResponse(
    request,
    ctx,
    async () =>
      new Response(await load(), {
        headers: {
          "content-type": "application/atom+xml; charset=utf-8",
          "cache-control": cacheControl,
        },
      }),
    options,
  );
}
