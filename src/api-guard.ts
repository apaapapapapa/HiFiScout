function apiBucket(pathname) {
  if (pathname === "/api/products") return "products";
  if (/^\/api\/products\/\d+\/history$/.test(pathname)) return "history";
  if (pathname === "/api/meta") return "meta";
  if (pathname === "/api/health") return "health";
  return null;
}

export async function checkPublicApiRateLimit(request, env) {
  if (request.method !== "GET" || !env.API_RATE_LIMITER) return { allowed: true };
  const url = new URL(request.url);
  const bucket = apiBucket(url.pathname);
  if (!bucket) return { allowed: true };

  // HiFiScout is anonymous. A high per-IP ceiling is used only as an abuse brake;
  // normal traffic is primarily protected by edge response caching.
  const actor = request.headers.get("cf-connecting-ip") || "unknown";
  const result = await env.API_RATE_LIMITER.limit({ key: `${actor}:${bucket}` });
  return { allowed: result.success, bucket };
}
