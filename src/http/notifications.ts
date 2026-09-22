import { json, rateLimiterUnavailableResponse } from "./response.js";
import { isJsonRequest } from "./request.js";

export async function handleNotificationRoute(
  request: Request,
  env: Env,
  cacheOnly: boolean,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/notifications/")) return null;
  if (cacheOnly) return rateLimiterUnavailableResponse();
  if (env.NOTIFICATIONS_ENABLED !== "true" || !env.NOTIFICATIONS)
    return json({ error: "notifications_unavailable" }, { status: 503 });
  const path = url.pathname.slice("/api/notifications".length);
  const valid =
    (request.method === "GET" && ["/config", "/status"].includes(path)) ||
    (request.method === "POST" && ["/device", "/watches"].includes(path)) ||
    (request.method === "DELETE" &&
      (path === "/device" || /^\/watches\/[a-zA-Z0-9-]{1,80}$/.test(path)));
  if (!valid) return json({ error: "not_found" }, { status: 404 });
  if (request.method !== "GET") {
    if (request.headers.get("origin") !== url.origin)
      return json({ error: "notification_origin_required" }, { status: 403 });
    if (request.method === "POST" && !isJsonRequest(request))
      return json({ error: "json_required" }, { status: 415 });
  }
  if (request.headers.get("sec-fetch-site") === "cross-site")
    return json({ error: "notification_origin_required" }, { status: 403 });
  const internal = new URL(`https://notification.internal${path}`);
  const stub = env.NOTIFICATIONS.get(env.NOTIFICATIONS.idFromName("v1"));
  let response: Response;
  try {
    response = await stub.fetch(new Request(internal, request));
  } catch {
    return json(
      { error: "notifications_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
