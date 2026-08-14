/** JSON response construction and the edge-cache wrapper the read endpoints share. */

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
): Promise<Response> {
  const cacheControl = `public, max-age=${ttlSeconds}`;
  if (typeof caches === "undefined") {
    return json(await load(), { headers: { "cache-control": cacheControl } });
  }
  const cache = (caches as CacheStorage & { readonly default: Cache }).default;
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = json(await load(), { headers: { "cache-control": cacheControl } });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}
