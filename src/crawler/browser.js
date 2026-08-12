import { fetchRobotsPolicy, getCrawlDelayMs, isPathAllowed } from "./robots.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function crawlError(status) {
  if (status === 403 || status === 429) {
    const error = new Error(`crawl blocked with HTTP ${status}`);
    error.status = status;
    return error;
  }
  const error = new Error(`crawl failed with HTTP ${status}`);
  error.status = status;
  return error;
}

async function prepareRequest(url, { baseUrl, userAgent, requestDelayMs, fetchFn, robotsCache }) {
  const origin = new URL(baseUrl || url).origin;
  let robotsText;
  let fetchedRobots = false;

  if (robotsCache.has(origin)) {
    robotsText = robotsCache.get(origin);
  } else {
    robotsText = await fetchRobotsPolicy(fetchFn, origin, userAgent);
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

export function createBrowserHtmlFetcher(browserBinding, { launchBrowser = null } = {}) {
  let browser = null;
  let page = null;
  let pageOrigin = null;
  let launchBrowserFn = launchBrowser;

  async function ensurePage() {
    if (!browserBinding) throw new Error("Browser Run binding is not configured");
    if (!launchBrowserFn) {
      const { launch } = await import("@cloudflare/playwright");
      launchBrowserFn = launch;
    }
    if (!browser) browser = await launchBrowserFn(browserBinding, { keep_alive: 120_000 });
    if (!page) page = await browser.newPage();
    return page;
  }

  async function navigate(targetPage, url) {
    const response = await targetPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const status = response?.status() ?? 0;
    if (status < 200 || status >= 400) throw crawlError(status);
    pageOrigin = new URL(targetPage.url()).origin;
    return targetPage.content();
  }

  async function browserFetch(targetPage, url) {
    const result = await targetPage.evaluate(async (targetUrl) => {
      const response = await fetch(targetUrl, { cache: "no-store", credentials: "same-origin" });
      return { status: response.status, html: await response.text() };
    }, url);
    if (result.status < 200 || result.status >= 400) throw crawlError(result.status);
    return result.html;
  }

  return {
    async fetchHtmlPage(url, options) {
      const effectiveDelayMs = await prepareRequest(url, options);
      try {
        const targetPage = await ensurePage();
        const targetOrigin = new URL(url).origin;
        const html =
          pageOrigin === targetOrigin
            ? await browserFetch(targetPage, url)
            : await navigate(targetPage, url);
        if (effectiveDelayMs > 0) await sleep(effectiveDelayMs);
        return html;
      } catch (error) {
        if (error?.status) throw error;
        throw new Error(
          `browser crawl failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async close() {
      const current = browser;
      browser = null;
      page = null;
      pageOrigin = null;
      if (current) await current.close().catch(() => {});
    },
  };
}
