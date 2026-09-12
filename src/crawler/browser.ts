import { fetchRobotsPolicy, getCrawlDelayMs, isPathAllowed } from "./robots.js";
import { CRAWL_MAX_HTML_RESPONSE_BYTES, CrawlResponseTooLargeError } from "./response-limits.js";
import { CrawlRedirectRejectedError, allowedOriginSet } from "./redirects.js";
import { isRecord } from "../types.js";
import type {
  AugmentedCrawlError,
  FetchHtmlPageOptions,
  HtmlTransport,
  RobotsCache,
} from "./types.js";

interface BrowserResponseLike {
  status(): number;
}

interface BrowserPageLike {
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<BrowserResponseLike | null>;
  url(): string;
  content(): Promise<string>;
  evaluate(
    pageFunction: (argument: string) => Promise<{ status: number; html: string }>,
    argument: string,
  ): Promise<{ status: number; html: string }>;
}

interface BrowserLike {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}

type LaunchBrowser = (
  browserBinding: BrowserRun | object,
  options: { keep_alive: number },
) => Promise<BrowserLike>;

interface BrowserFetcherOptions {
  launchBrowser?: LaunchBrowser | null;
}

interface PreparedRequestOptions extends FetchHtmlPageOptions {
  fetchFn: typeof fetch;
  robotsCache: RobotsCache;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function crawlError(status: number): AugmentedCrawlError {
  if (status === 403 || status === 429) {
    const error: AugmentedCrawlError = new Error(`crawl blocked with HTTP ${status}`);
    error.status = status;
    return error;
  }
  const error: AugmentedCrawlError = new Error(`crawl failed with HTTP ${status}`);
  error.status = status;
  return error;
}

async function prepareRequest(
  url: string,
  { baseUrl, userAgent, requestDelayMs, fetchFn, robotsCache }: PreparedRequestOptions,
): Promise<number> {
  const origin = new URL(baseUrl || url).origin;
  let robotsText;
  let fetchedRobots = false;

  if (robotsCache.has(origin)) {
    robotsText = robotsCache.get(origin);
  } else {
    robotsText = await fetchRobotsPolicy(fetchFn, origin, userAgent, {
      allowedOrigins: allowedOriginSet([origin]),
    });
    robotsCache.set(origin, robotsText);
    fetchedRobots = true;
  }

  if (!isPathAllowed(robotsText, url, userAgent)) {
    throw new Error(`robots.txt disallows crawling ${url}`);
  }

  const effectiveDelayMs = Math.max(requestDelayMs, getCrawlDelayMs(robotsText, userAgent));
  if (fetchedRobots && effectiveDelayMs > 0) await sleep(effectiveDelayMs);
  return effectiveDelayMs;
}

export function createBrowserHtmlFetcher(
  browserBinding: BrowserRun | object | undefined,
  { launchBrowser = null }: BrowserFetcherOptions = {},
): HtmlTransport & { close(): Promise<void> } {
  let browser: BrowserLike | null = null;
  let page: BrowserPageLike | null = null;
  let pageOrigin: string | null = null;
  let launchBrowserFn = launchBrowser;

  async function ensurePage(): Promise<BrowserPageLike> {
    if (!browserBinding) throw new Error("Browser Run binding is not configured");
    if (!launchBrowserFn) {
      const { launch } = await import("@cloudflare/playwright");
      launchBrowserFn = launch as LaunchBrowser;
    }
    if (!browser) browser = await launchBrowserFn(browserBinding, { keep_alive: 120_000 });
    if (!page) page = await browser.newPage();
    return page;
  }

  /**
   * Rendering happens in the remote browser session, so the Worker can only bound what crosses back
   * to it. The residual risk is the browser session's own buffering, which this transport does not
   * control; the ceiling below is what protects the Worker's decoder and parser.
   *
   * The budget is in bytes, so the check is too: one Japanese character is three UTF-8 bytes, and
   * counting UTF-16 code units would let a page three times over the ceiling through. The length
   * comparison is only a cheap pre-filter — a string longer than the ceiling can never encode to
   * fewer bytes — that avoids encoding an obviously oversized page just to measure it.
   */
  function boundedContent(html: string, maxBytes: number): string {
    if (html.length > maxBytes || new TextEncoder().encode(html).byteLength > maxBytes) {
      throw new CrawlResponseTooLargeError(maxBytes);
    }
    return html;
  }

  /**
   * The remote browser follows redirects itself, so this transport can only check where navigation
   * ended up. That is a weaker guarantee than the direct and relay transports, which validate each
   * hop before sending, and it is why this check rejects the *content*: the request already
   * happened. No shop currently uses this transport.
   */
  function assertLandedOnAllowedOrigin(
    finalUrl: string,
    allowedOrigins: ReadonlySet<string>,
  ): void {
    const landed = new URL(finalUrl);
    if (landed.protocol !== "https:" || !allowedOrigins.has(landed.origin)) {
      throw new CrawlRedirectRejectedError(
        `browser navigation ended on ${landed.origin}, which is not allowed for this shop`,
      );
    }
  }

  async function navigate(
    targetPage: BrowserPageLike,
    url: string,
    allowedOrigins: ReadonlySet<string>,
    maxBytes: number,
  ): Promise<string> {
    const response = await targetPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const status = response?.status() ?? 0;
    if (status < 200 || status >= 400) throw crawlError(status);
    assertLandedOnAllowedOrigin(targetPage.url(), allowedOrigins);
    pageOrigin = new URL(targetPage.url()).origin;
    return boundedContent(await targetPage.content(), maxBytes);
  }

  async function browserFetch(
    targetPage: BrowserPageLike,
    url: string,
    maxBytes: number,
  ): Promise<string> {
    const result = await targetPage.evaluate(async (targetUrl) => {
      const response = await fetch(targetUrl, { cache: "no-store", credentials: "same-origin" });
      return { status: response.status, html: await response.text() };
    }, url);
    if (result.status < 200 || result.status >= 400) throw crawlError(result.status);
    return boundedContent(result.html, maxBytes);
  }

  return {
    async fetchHtmlPage(url: string, options: FetchHtmlPageOptions): Promise<string> {
      const allowedOrigins = allowedOriginSet([
        options.baseUrl || url,
        ...(options.allowedRedirectOrigins ?? []),
      ]);
      const effectiveDelayMs = await prepareRequest(url, {
        ...options,
        fetchFn: options.fetchFn ?? globalThis.fetch,
        robotsCache: options.robotsCache ?? new Map<string, string | null>(),
      });
      const maxBytes = options.maxResponseBytes ?? CRAWL_MAX_HTML_RESPONSE_BYTES;
      try {
        const targetPage = await ensurePage();
        const targetOrigin = new URL(url).origin;
        const html =
          pageOrigin === targetOrigin
            ? await browserFetch(targetPage, url, maxBytes)
            : await navigate(targetPage, url, allowedOrigins, maxBytes);
        if (effectiveDelayMs > 0) await sleep(effectiveDelayMs);
        return html;
      } catch (error) {
        if (isRecord(error) && typeof error.status === "number" && error.status) throw error;
        // A size or destination refusal must stay identifiable rather than becoming a generic failure.
        if (error instanceof CrawlResponseTooLargeError) throw error;
        if (error instanceof CrawlRedirectRejectedError) throw error;
        throw new Error(
          `browser crawl failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async close(): Promise<void> {
      const current = browser;
      browser = null;
      page = null;
      pageOrigin = null;
      if (current) await current.close().catch(() => {});
    },
  };
}
