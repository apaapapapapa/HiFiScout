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
): Promise<Response> {
  if (typeof caches === "undefined") return load();
  const cache = (caches as CacheStorage & { readonly default: Cache }).default;
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await load();
  if (response.ok) ctx.waitUntil(cache.put(request, response.clone()));
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
): Promise<Response> {
  const cacheControl = `public, max-age=${ttlSeconds}`;
  return cachedResponse(request, ctx, async () =>
    json(await load(), { headers: { "cache-control": cacheControl } }),
  );
}

/** Atom/XML sibling of {@link cachedJson}; keeps XML out of the JSON serializer. */
export async function cachedAtom(
  request: Request,
  ctx: ExecutionContext,
  ttlSeconds: number,
  load: () => string | Promise<string>,
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
  );
}
