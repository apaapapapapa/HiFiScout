import type { AugmentedCrawlError, FetchHtmlPageOptions } from "./types.js";
import { fetchRobotsPolicy, getCrawlDelayMs, isPathAllowed } from "./robots.js";
import {
  CRAWL_MAX_HTML_RESPONSE_BYTES,
  readLimitedResponseText,
  type LimitedResponseReadOptions,
} from "./response-limits.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const CRAWL_HTTP_TIMEOUT_MS = 30_000;

function responseCharset(contentType = ""): string {
  const raw = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]?.toLowerCase();
  if (!raw) return "utf-8";
  return (
    {
      euc_jp: "euc-jp",
      eucjp: "euc-jp",
      "shift-jis": "shift_jis",
      shift_jis: "shift_jis",
      sjis: "shift_jis",
      "x-sjis": "shift_jis",
    }[raw] || raw
  );
}

/**
 * Decodes an HTML body using its declared charset, reading at most {@link CRAWL_MAX_HTML_RESPONSE_BYTES}.
 *
 * Callers pass the deadline that bounded the request so a body that stops mid-stream ends with the
 * request rather than holding the invocation open.
 */
export async function decodeHtmlResponse(
  response: Response,
  { maxBytes = CRAWL_MAX_HTML_RESPONSE_BYTES, signal }: Partial<LimitedResponseReadOptions> = {},
): Promise<string> {
  return readLimitedResponseText(response, {
    maxBytes,
    signal,
    charset: responseCharset(response.headers.get("content-type") || ""),
  });
}

export async function fetchHtmlPage(
  url: string,
  {
    baseUrl,
    userAgent,
    requestDelayMs,
    fetchFn = fetch,
    robotsCache = new Map(),
    timeoutMs = CRAWL_HTTP_TIMEOUT_MS,
    maxResponseBytes = CRAWL_MAX_HTML_RESPONSE_BYTES,
  }: FetchHtmlPageOptions,
): Promise<string> {
  let robotsFetchedNow = false;
  if (!robotsCache.has(baseUrl)) {
    robotsCache.set(baseUrl, await fetchRobotsPolicy(fetchFn, baseUrl, userAgent));
    robotsFetchedNow = true;
  }
  const robotsText = robotsCache.get(baseUrl);
  if (!isPathAllowed(robotsText, url, userAgent)) {
    throw new Error(`robots.txt disallows ${new URL(url).pathname}`);
  }

  const effectiveDelayMs = Math.max(
    Number(requestDelayMs) || 0,
    getCrawlDelayMs(robotsText, userAgent),
  );
  if (robotsFetchedNow && effectiveDelayMs > 0) await sleep(effectiveDelayMs);

  // A single upstream that never answers must fail inside the crawler's catch/backoff path
  // instead of consuming the Queue worker's 15-minute wall-clock budget and disappearing as a
  // hard kill with only last_attempt_at advanced. The same deadline covers the body: a seller that
  // sends headers and then stalls halfway through the page is the same outage.
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetchFn(url, {
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en;q=0.7",
      "Cache-Control": "no-cache",
    },
    redirect: "follow",
    signal: deadline,
  });

  if (response.status === 403 || response.status === 429) {
    const error: AugmentedCrawlError = new Error(`crawl blocked with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (!response.ok) throw new Error(`crawl failed with HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html"))
    throw new Error(`unexpected content type: ${contentType}`);
  const html = await decodeHtmlResponse(response, {
    signal: deadline,
    maxBytes: maxResponseBytes,
  });
  if (effectiveDelayMs > 0) await sleep(effectiveDelayMs);
  return html;
}
