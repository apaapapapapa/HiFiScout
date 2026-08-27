/** Public API routes that carry their own rate-limit bucket. */
export type ApiRateLimitBucket =
  | "products"
  | "product-search"
  | "feed"
  | "suggest"
  | "history"
  | "meta"
  | "health"
  | "correction-reports"
  | "unknown-api";

/**
 * The slice of `Env` this guard reads. The binding is optional so tests (and any deployment
 * without the limiter configured) can call the guard with a bare object.
 */
export interface ApiRateLimitEnv {
  readonly API_RATE_LIMITER?: RateLimit;
}

/** The slice of `Request` this guard reads; the Worker `Request` satisfies it. */
export interface ApiRateLimitRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Pick<Headers, "get">;
}

export interface ApiRateLimitResult {
  allowed: boolean;
  bucket?: ApiRateLimitBucket;
}

/**
 * Every public API request gets a bucket before it can reach a handler. Unknown `/api/` paths use
 * a bounded fallback rather than bypassing the limiter, which keeps a future write route from being
 * accidentally exposed without an explicit bucket.
 */
export function apiBucket(pathname: string, method = "GET"): ApiRateLimitBucket | null {
  if (method === "POST" && pathname === "/api/product-correction-reports") {
    return "correction-reports";
  }
  if (method !== "GET") return pathname.startsWith("/api/") ? "unknown-api" : null;
  if (pathname === "/api/products") return "products";
  if (pathname === "/api/feed") return "feed";
  if (pathname === "/api/suggest") return "suggest";
  if (pathname === "/p" || pathname.startsWith("/p/")) return "product-search";
  if (
    pathname === "/api/product-search" ||
    /^\/api\/product-search\/[a-z]-\d{1,15}$/.test(pathname)
  ) {
    return "product-search";
  }
  if (/^\/api\/products\/\d+\/history$/.test(pathname)) return "history";
  if (pathname === "/api/meta") return "meta";
  if (pathname === "/api/health") return "health";
  return pathname.startsWith("/api/") ? "unknown-api" : null;
}

export async function checkPublicApiRateLimit(
  request: ApiRateLimitRequest,
  env: ApiRateLimitEnv,
): Promise<ApiRateLimitResult> {
  if (!env.API_RATE_LIMITER) return { allowed: true };
  const url = new URL(request.url);
  const bucket = apiBucket(url.pathname, request.method);
  if (!bucket) return { allowed: true };

  // HiFiScout is anonymous. A high per-IP ceiling is used only as an abuse brake;
  // normal read traffic is primarily protected by edge response caching. The identity is transient
  // and never persisted with a correction report.
  const actor = request.headers.get("cf-connecting-ip") || "unknown";
  const result = await env.API_RATE_LIMITER.limit({ key: `${actor}:${bucket}` });
  return { allowed: result.success, bucket };
}
