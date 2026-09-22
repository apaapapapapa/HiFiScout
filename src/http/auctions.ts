import { yahooAuctionAccess } from "../auctions/yahoo/policy.js";
import { AuctionQueryError, parseAuctionQuery } from "../api/auction-query.js";
import { json, rateLimiterUnavailableResponse } from "./response.js";

/** Independent bounded saved-data read; it never calls a seller or the shared catalog DB. */
export async function handleAuctionRoute(
  request: Request,
  env: Env,
  cacheOnly: boolean,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!["/api/auctions", "/api/auction-features"].includes(url.pathname)) return null;
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });
  const access = yahooAuctionAccess(env);
  if (url.pathname === "/api/auction-features")
    return json({ search: access.search, display: access.display });
  if (!access.search) return json({ error: "auction_disabled" }, { status: 404 });
  try {
    parseAuctionQuery(url);
  } catch (error) {
    if (error instanceof AuctionQueryError) return json({ error: error.message }, { status: 400 });
    throw error;
  }
  // No shared edge/browser cache: a hard pause takes effect at the next admitted request.
  if (cacheOnly) return rateLimiterUnavailableResponse();
  const target = new URL(url);
  target.pathname = "/search";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      env.YAHOO_AUCTIONS.get(env.YAHOO_AUCTIONS.idFromName("yahoo-auctions-v1")).fetch(
        new Request(target, { method: "GET" }),
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("auction_timeout")), 2000);
      }),
    ]);
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return json({ error: "auction_unavailable" }, { status: 503 });
  } finally {
    clearTimeout(timeout);
  }
}
