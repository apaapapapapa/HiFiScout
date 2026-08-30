import { decodeHtmlResponse } from "./fetch.js";
import { fetchRobotsPolicy, getCrawlDelayMs, isPathAllowed } from "./robots.js";
import type { AugmentedCrawlError } from "./types.js";

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
  }: {
    baseUrl: string;
    userAgent: string;
    requestDelayMs: number;
    fetchFn?: typeof fetch;
    nowMs?: number;
  },
): Promise<DirectFetchPermit> {
  const robotsText = await fetchRobotsPolicy(fetchFn, baseUrl, userAgent);
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

/** Fetches the exact target authorized by a prepared permit without introducing any sleep. */
export async function fetchPreparedDirectHtmlPage(
  permit: DirectFetchPermit,
  targetUrl: string,
  {
    userAgent,
    fetchFn = fetch,
    nowMs = Date.now(),
  }: { userAgent: string; fetchFn?: typeof fetch; nowMs?: number },
): Promise<string> {
  if (targetUrl !== permit.targetUrl || userAgent !== permit.userAgent) {
    throw new Error("direct fetch permit identity mismatch");
  }
  if (nowMs < permit.notBeforeMs) {
    throw new Error(`direct fetch permit is not ready until ${permit.notBeforeMs}`);
  }

  const response = await fetchFn(targetUrl, {
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en;q=0.7",
      "Cache-Control": "no-cache",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(CRAWL_HTTP_TIMEOUT_MS),
  });
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
  return decodeHtmlResponse(response);
}
