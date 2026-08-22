import type { AugmentedCrawlError, FetchHtmlPageOptions } from "./types.js";
import { fetchRobotsPolicy, getCrawlDelayMs, isPathAllowed } from "./robots.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CRAWL_HTTP_TIMEOUT_MS = 30_000;

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

export async function decodeHtmlResponse(response: Response): Promise<string> {
  const bytes = await response.arrayBuffer();
  const charset = responseCharset(response.headers.get("content-type") || "");
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export async function fetchHtmlPage(
  url: string,
  {
    baseUrl,
    userAgent,
    requestDelayMs,
    fetchFn = fetch,
    robotsCache = new Map(),
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

  const response = await fetchFn(url, {
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en;q=0.7",
      "Cache-Control": "no-cache",
    },
    redirect: "follow",
    // A single upstream that never answers must fail inside the crawler's catch/backoff path
    // instead of consuming the Queue worker's 15-minute wall-clock budget and disappearing as a
    // hard kill with only last_attempt_at advanced.
    signal: AbortSignal.timeout(CRAWL_HTTP_TIMEOUT_MS),
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
  const html = await decodeHtmlResponse(response);
  if (effectiveDelayMs > 0) await sleep(effectiveDelayMs);
  return html;
}
