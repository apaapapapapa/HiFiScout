import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { createBrowserHtmlFetcher } from "../src/crawler/browser.js";

function browserHarness(contentHtml = "<html>first</html>") {
  const calls = { launch: 0, newPage: 0, goto: 0, evaluate: 0, close: 0 };
  let currentUrl = "about:blank";
  const page = {
    async goto(url: string) {
      calls.goto += 1;
      currentUrl = url;
      return { status: () => 200 };
    },
    url() {
      return currentUrl;
    },
    async content() {
      return contentHtml;
    },
    async evaluate(_fn: unknown, url: string) {
      calls.evaluate += 1;
      return { status: 200, html: `<html>${url}</html>` };
    },
  };
  const browser = {
    async newPage() {
      calls.newPage += 1;
      return page;
    },
    async close() {
      calls.close += 1;
    },
  };
  return {
    calls,
    launchBrowser: async () => {
      calls.launch += 1;
      return browser;
    },
  };
}

const fetchOptions = () => ({
  baseUrl: "https://example.com",
  userAgent: "HiFiScoutBot/0.1",
  requestDelayMs: 0,
  fetchFn: async () => new Response("", { status: 404 }),
  robotsCache: new Map(),
});

test("Browser Run transport launches once and reuses the page for same-origin fetches", async () => {
  const harness = browserHarness();
  const fetcher = createBrowserHtmlFetcher({}, { launchBrowser: harness.launchBrowser });
  const options = fetchOptions();

  assert.equal(
    await fetcher.fetchHtmlPage("https://example.com/page-1", options),
    "<html>first</html>",
  );
  assert.equal(
    await fetcher.fetchHtmlPage("https://example.com/page-2", options),
    "<html>https://example.com/page-2</html>",
  );
  await fetcher.close();

  assert.deepEqual(harness.calls, { launch: 1, newPage: 1, goto: 1, evaluate: 1, close: 1 });
});

test("Browser Run transport preserves blocked HTTP status errors", async () => {
  const harness = browserHarness();
  const fetcher = createBrowserHtmlFetcher(
    {},
    {
      launchBrowser: async () => ({
        async newPage() {
          return {
            async goto() {
              return { status: () => 403 };
            },
            url() {
              return "https://example.com/page-1";
            },
            async content() {
              return "";
            },
            async evaluate() {
              return { status: 200, html: "" };
            },
          };
        },
        async close() {},
      }),
    },
  );

  await assert.rejects(
    fetcher.fetchHtmlPage("https://example.com/page-1", fetchOptions()),
    /crawl blocked with HTTP 403/,
  );
  await fetcher.close();
  assert.equal(harness.calls.launch, 0);
});

test("Browser Run transport refuses a page over the byte ceiling, counting UTF-8 bytes", async () => {
  const japanese = "中".repeat(400);
  const harness = browserHarness(japanese);
  const fetcher = createBrowserHtmlFetcher({}, { launchBrowser: harness.launchBrowser });

  // 400 characters, 1200 UTF-8 bytes: a code-unit comparison against the same ceiling would pass.
  await assert.rejects(
    fetcher.fetchHtmlPage("https://example.com/page-1", {
      ...fetchOptions(),
      maxResponseBytes: 600,
    }),
    /exceeded the 600 byte limit/u,
  );

  // A fresh session: the rejected navigation above already pinned the page's origin, which would
  // route a second call through the same-origin fetch path instead of navigation.
  const allowed = createBrowserHtmlFetcher(
    {},
    { launchBrowser: browserHarness(japanese).launchBrowser },
  );
  const ok = await allowed.fetchHtmlPage("https://example.com/page-1", {
    ...fetchOptions(),
    maxResponseBytes: 1200,
  });
  assert.equal(ok.length, 400);
});
