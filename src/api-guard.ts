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
 * The slice of `Env` this guard reads.
 *
 * The binding stays optional in the type so a test can hand the guard a bare object, but an absent
 * binding is a configuration failure at runtime, never a pass: a deployment without the limiter must
 * refuse the routes it protects rather than serve them without one. Tests supply an explicit mock.
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

/**
 * - `allowed` — within the limit, or a route the limiter does not cover.
 * - `limited` — the caller is over its limit. The answer is 429.
 * - `unavailable` — the limiter could not decide: the binding is missing, or `.limit()` failed.
 *   The protected routes answer 503; an already-cached read may still be served, but nothing may
 *   fall through to D1.
 */
export type ApiRateLimitDecision = "allowed" | "limited" | "unavailable";

export interface ApiRateLimitResult {
  allowed: boolean;
  decision: ApiRateLimitDecision;
  bucket?: ApiRateLimitBucket;
}

/**
 * Every public API request gets a bucket before it can reach a handler. Unknown `/api/` paths use
 * a bounded fallback rather than bypassing the limiter, which keeps a future write route from being
 * accidentally exposed without an explicit bucket. Retired `/api/admin/*` routes are blocked by the
 * outer public entrypoint and therefore deliberately remain outside this public limiter.
 */
export function apiBucket(pathname: string, method = "GET"): ApiRateLimitBucket | null {
  if (pathname.startsWith("/api/admin/")) return null;
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

/**
 * Isolate-local throttle for the degradation log.
 *
 * A limiter outage affects every request, so logging each one turns a defence failure into a second
 * incident. One line per isolate per window is enough to see it in Workers Observability; nothing
 * request-scoped is kept here.
 */
const DEGRADED_LOG_INTERVAL_MS = 60_000;
const lastDegradedLogMs = new Map<string, number>();

function logDegraded(event: string, bucket: ApiRateLimitBucket, reason?: string): void {
  const now = Date.now();
  const previous = lastDegradedLogMs.get(event);
  if (previous !== undefined && now - previous < DEGRADED_LOG_INTERVAL_MS) return;
  lastDegradedLogMs.set(event, now);
  console.error(JSON.stringify({ event, bucket, ...(reason ? { reason } : {}) }));
}

export async function checkPublicApiRateLimit(
  request: ApiRateLimitRequest,
  env: ApiRateLimitEnv,
): Promise<ApiRateLimitResult> {
  const url = new URL(request.url);
  // The bucket is resolved first so a limiter problem only ever affects the routes the limiter is
  // responsible for. Static assets and the retired admin paths carry no bucket and are untouched.
  const bucket = apiBucket(url.pathname, request.method);
  if (!bucket) return { allowed: true, decision: "allowed" };

  if (!env.API_RATE_LIMITER) {
    logDegraded("api_rate_limiter_binding_missing", bucket);
    return { allowed: false, decision: "unavailable", bucket };
  }

  // HiFiScout is anonymous. A high per-IP ceiling is used only as an abuse brake;
  // normal read traffic is primarily protected by edge response caching. The identity is transient
  // and never persisted with a correction report. `cf-connecting-ip` is set by the edge and is the
  // only client identity here that a caller cannot choose for itself.
  const actor = request.headers.get("cf-connecting-ip") || "unknown";
  try {
    const result = await env.API_RATE_LIMITER.limit({ key: `${actor}:${bucket}` });
    return {
      allowed: result.success,
      decision: result.success ? "allowed" : "limited",
      bucket,
    };
  } catch (error) {
    logDegraded(
      "api_rate_limiter_unavailable",
      bucket,
      error instanceof Error ? error.name : "unknown",
    );
    return { allowed: false, decision: "unavailable", bucket };
  }
}
