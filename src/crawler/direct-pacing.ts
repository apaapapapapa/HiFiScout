import { decodeHtmlResponse } from "./fetch.js";
import { createRobotsGate, fetchRobotsPolicy, getCrawlDelayMs, isPathAllowed } from "./robots.js";
import { allowedOriginSet, fetchFollowingValidatedRedirects } from "./redirects.js";
import type { AugmentedCrawlError, RelayPage, RobotsCache } from "./types.js";

const CRAWL_HTTP_TIMEOUT_MS = 30_000;

/**
 * Internal capability produced after robots policy has been evaluated for one exact seller URL.
 * The capability never leaves the per-shop Durable Object. Keeping only immutable timing/identity
 * metadata in DO storage avoids persisting robots bodies or seller HTML there.
 */
export interface DirectFetchPermit {
  targetUrl: string;
  userAgent: string;
  effectiveDelayMs: number;
  preparedAtMs: number;
  notBeforeMs: number;
}

export async function prepareDirectFetchPermit(
  targetUrl: string,
  {
    baseUrl,
    userAgent,
    requestDelayMs,
    fetchFn = fetch,
    nowMs = Date.now(),
    allowedRedirectOrigins = [],
  }: {
    baseUrl: string;
    userAgent: string;
    requestDelayMs: number;
    fetchFn?: typeof fetch;
    nowMs?: number;
    allowedRedirectOrigins?: readonly string[];
  },
): Promise<DirectFetchPermit> {
  const robotsText = await fetchRobotsPolicy(fetchFn, baseUrl, userAgent, {
    allowedOrigins: allowedOriginSet([baseUrl, ...allowedRedirectOrigins]),
  });
  if (!isPathAllowed(robotsText, targetUrl, userAgent)) {
    throw new Error(`robots.txt disallows ${new URL(targetUrl).pathname}`);
  }
  const effectiveDelayMs = Math.max(
    Number(requestDelayMs) || 0,
    getCrawlDelayMs(robotsText, userAgent),
  );
  return {
    targetUrl,
    userAgent,
    effectiveDelayMs,
    preparedAtMs: nowMs,
    notBeforeMs: nowMs + effectiveDelayMs,
  };
}

interface PreparedDirectRequestOptions {
  userAgent: string;
  fetchFn?: typeof fetch;
  nowMs?: number;
  allowedRedirectOrigins?: readonly string[];
  robotsCache?: RobotsCache;
  exactTargetOnly?: boolean;
}

/**
 * Requests the exact target authorized by a prepared permit without introducing any sleep, and
 * returns the final response of its validated redirect chain together with the chain's deadline.
 */
async function requestPreparedDirect(
  permit: DirectFetchPermit,
  targetUrl: string,
  {
    userAgent,
    fetchFn = fetch,
    nowMs = Date.now(),
    allowedRedirectOrigins = [],
    robotsCache = new Map(),
    exactTargetOnly = false,
  }: PreparedDirectRequestOptions,
): Promise<{ response: Response; deadline: AbortSignal }> {
  if (targetUrl !== permit.targetUrl || userAgent !== permit.userAgent) {
    throw new Error("direct fetch permit identity mismatch");
  }
  if (nowMs < permit.notBeforeMs) {
    throw new Error(`direct fetch permit is not ready until ${permit.notBeforeMs}`);
  }

  // The permit authorized one exact URL whose robots policy was already evaluated, so only that URL
  // starts without a re-check; every redirect destination is validated and re-evaluated before it is
  // requested. One deadline covers the chain and the body.
  const allowedOrigins = allowedOriginSet([
    new URL(permit.targetUrl).origin,
    ...allowedRedirectOrigins,
  ]);
  const deadline = AbortSignal.timeout(CRAWL_HTTP_TIMEOUT_MS);
  const robotsGate = createRobotsGate({ fetchFn, userAgent, robotsCache, allowedOrigins });
  const response = await fetchFollowingValidatedRedirects(
    targetUrl,
    {
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ja,en;q=0.7",
        "Cache-Control": "no-cache",
      },
    },
    {
      fetchFn,
      allowedOrigins,
      signal: deadline,
      beforeRequest: async (destination, signal) => {
        if (destination === permit.targetUrl) return;
        if (exactTargetOnly) throw new Error("inventory redirect changed product identity");
        await robotsGate(destination, signal);
      },
    },
  );
  return { response, deadline };
}

/** Fetches the exact target authorized by a prepared permit without introducing any sleep. */
export async function fetchPreparedDirectHtmlPage(
  permit: DirectFetchPermit,
  targetUrl: string,
  options: PreparedDirectRequestOptions,
): Promise<string> {
  const { response, deadline } = await requestPreparedDirect(permit, targetUrl, options);
  if (response.status === 403 || response.status === 429) {
    const error: AugmentedCrawlError = new Error(`crawl blocked with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (!response.ok) throw new Error(`crawl failed with HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    throw new Error(`unexpected content type: ${contentType}`);
  }
  return decodeHtmlResponse(response, { signal: deadline });
}

/**
 * Fetches a prepared target and reports its outcome instead of failing on a non-success status, in
 * the same shape the Relay returns. Inventory recheck reads a 404 as evidence, not as an error; only
 * a 200 HTML body is read, and every other body is released unread.
 */
export async function fetchPreparedDirectPage(
  permit: DirectFetchPermit,
  targetUrl: string,
  options: PreparedDirectRequestOptions,
): Promise<RelayPage> {
  const { response, deadline } = await requestPreparedDirect(permit, targetUrl, {
    ...options,
    exactTargetOnly: true,
  });
  const contentType = response.headers.get("content-type") || "";
  if (response.status !== 200 || !contentType.toLowerCase().includes("text/html")) {
    await response.body?.cancel().catch(() => {});
    return { status: response.status, contentType, body: "", finalUrl: targetUrl };
  }
  return {
    status: response.status,
    contentType,
    body: await decodeHtmlResponse(response, { signal: deadline }),
    finalUrl: targetUrl,
  };
}
