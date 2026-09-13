import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { fetchHtmlPage } from "../src/crawler/fetch.js";
import { CrawlRedirectRejectedError } from "../src/crawler/redirects.js";
import { createRelayHtmlFetcher } from "../src/crawler/relay.js";
import { processFetch } from "../src/crawler/resumable-page-steps.js";
import type { ResumableRuntimeEnv } from "../src/crawler/resumable-queue-contract.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import {
  ensureCrawlFetchSession,
  getCrawlFetchSession,
} from "../src/db/crawl-fetch-session-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { recordingDatabase } from "./helpers/query-plan.js";

const BASE = "https://example.com";
const PAGE = `${BASE}/used`;
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

function html(body = "<html>ok</html>"): Response {
  return new Response(body, { status: 200, headers: HTML_HEADERS });
}

function redirect(location: string | null, status = 302): Response {
  const headers = new Headers();
  if (location !== null) headers.set("location", location);
  return new Response(null, { status, headers });
}

interface Recorder {
  urls: string[];
  signals: (AbortSignal | null | undefined)[];
  fetchFn: typeof fetch;
}

/** Records every destination actually requested, so a rejected one is visibly never contacted. */
function recorder(
  handler: (url: string, requestNumber: number) => Response | Promise<Response>,
  { robots = "" }: { robots?: string } = {},
): Recorder {
  const urls: string[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  let requests = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) {
      urls.push(url);
      return new Response(robots, { status: robots ? 200 : 404 });
    }
    requests += 1;
    urls.push(url);
    signals.push(init?.signal);
    return handler(url, requests);
  };
  return { urls, signals, fetchFn };
}

function page(overrides: Partial<Parameters<typeof fetchHtmlPage>[1]> = {}) {
  return {
    baseUrl: BASE,
    userAgent: "HiFiScoutBot/0.1",
    requestDelayMs: 0,
    ...overrides,
  } as Parameters<typeof fetchHtmlPage>[1];
}

test("a same-origin redirect is followed", async () => {
  const record = recorder((url) => (url.endsWith("/used/") ? html() : redirect(`${BASE}/used/`)));
  const result = await fetchHtmlPage(PAGE, page({ fetchFn: record.fetchFn }));
  assert.equal(result, "<html>ok</html>");
  assert.deepEqual(record.urls, [`${BASE}/robots.txt`, PAGE, `${BASE}/used/`]);
});

test("a relative Location is resolved against the URL that produced it", async () => {
  const record = recorder((url) =>
    url === `${BASE}/catalog/page-2` ? html("<html>page 2</html>") : redirect("./page-2"),
  );
  const result = await fetchHtmlPage(`${BASE}/catalog/used`, page({ fetchFn: record.fetchFn }));
  assert.equal(result, "<html>page 2</html>");
  assert.ok(record.urls.includes(`${BASE}/catalog/page-2`));
});

test("a redirect to another origin is refused before the request is sent", async () => {
  const record = recorder(() => redirect("https://evil.example.net/used"));
  await assert.rejects(
    fetchHtmlPage(PAGE, page({ fetchFn: record.fetchFn })),
    (error: unknown) =>
      error instanceof CrawlRedirectRejectedError && /evil\.example\.net/u.test(error.message),
  );
  assert.equal(
    // Compared as a whole origin, exactly as the guard under test does: a substring check is the
    // mistake this change exists to remove.
    record.urls.some((url) => new URL(url).origin === "https://evil.example.net"),
    false,
    "the refused destination must never receive a request",
  );
});

test("a look-alike origin is not accepted by prefix or suffix similarity", async () => {
  for (const location of [
    "https://example.com.attacker.test/used",
    "https://notexample.com/used",
    "https://example.com:8443/used",
  ]) {
    const record = recorder(() => redirect(location));
    await assert.rejects(
      fetchHtmlPage(PAGE, page({ fetchFn: record.fetchFn })),
      (error: unknown) => error instanceof CrawlRedirectRejectedError,
    );
    assert.equal(record.urls.length, 2, `${location} must not be requested`);
  }
});

test("a downgrade to HTTP is refused", async () => {
  const record = recorder(() => redirect("http://example.com/used"));
  await assert.rejects(
    fetchHtmlPage(PAGE, page({ fetchFn: record.fetchFn })),
    (error: unknown) =>
      error instanceof CrawlRedirectRejectedError && /not HTTPS/u.test(error.message),
  );
  assert.equal(
    record.urls.some((url) => new URL(url).protocol === "http:"),
    false,
  );
});

test("a destination carrying credentials is refused without echoing them", async () => {
  const record = recorder(() => redirect("https://user:secret@example.com/used"));
  await assert.rejects(
    fetchHtmlPage(PAGE, page({ fetchFn: record.fetchFn })),
    (error: unknown) =>
      error instanceof CrawlRedirectRejectedError &&
      /embedded credentials/u.test(error.message) &&
      !error.message.includes("secret"),
  );
  assert.equal(record.urls.length, 2);
});

test("a redirect without a usable Location is refused", async () => {
  for (const location of [null, "   ", "http://["]) {
    const record = recorder(() => redirect(location));
    await assert.rejects(
      fetchHtmlPage(PAGE, page({ fetchFn: record.fetchFn })),
      (error: unknown) => error instanceof CrawlRedirectRejectedError,
    );
  }
});

test("a redirect loop ends instead of cycling", async () => {
  const record = recorder((url) =>
    url === PAGE ? redirect(`${BASE}/loop`) : redirect(`${BASE}/used`),
  );
  await assert.rejects(
    fetchHtmlPage(PAGE, page({ fetchFn: record.fetchFn })),
    (error: unknown) => error instanceof CrawlRedirectRejectedError && /loop/u.test(error.message),
  );
});

test("a chain longer than the hop limit is refused", async () => {
  const record = recorder((_url, requestNumber) => redirect(`${BASE}/hop-${requestNumber}`));
  await assert.rejects(
    fetchHtmlPage(PAGE, page({ fetchFn: record.fetchFn })),
    (error: unknown) =>
      error instanceof CrawlRedirectRejectedError && /more than 5 redirects/u.test(error.message),
  );
  // The initial request plus five followed redirects, and nothing beyond.
  assert.equal(record.urls.filter((url) => !url.endsWith("/robots.txt")).length, 6);
});

test("an unused redirect body is released", async () => {
  let cancelled = false;
  const record = recorder((url) => {
    if (url.endsWith("/used/")) return html();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(stream, { status: 302, headers: { location: `${BASE}/used/` } });
  });
  await fetchHtmlPage(PAGE, page({ fetchFn: record.fetchFn }));
  assert.equal(cancelled, true);
});

test("one deadline covers the whole chain rather than each hop", async () => {
  const record = recorder(
    (_url, requestNumber) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(redirect(`${BASE}/hop-${requestNumber}`)), 20);
        currentSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted by the crawl deadline"));
          },
          { once: true },
        );
      }),
  );
  let currentSignal: AbortSignal | undefined;
  const trackingFetch: typeof fetch = (input, init) => {
    currentSignal = init?.signal ?? undefined;
    return record.fetchFn(input, init);
  };

  await assert.rejects(
    fetchHtmlPage(PAGE, page({ fetchFn: trackingFetch, timeoutMs: 30 })),
    /aborted by the crawl deadline/u,
  );
  // Every hop shared one signal: a longer chain cannot buy itself more time.
  assert.ok(record.signals.length >= 2);
  assert.equal(new Set(record.signals).size, 1);
});

test("robots rules are re-applied to the redirect destination", async () => {
  const record = recorder(
    (url) => (url.endsWith("/members/used") ? html() : redirect(`${BASE}/members/used`)),
    { robots: "User-agent: *\nDisallow: /members/\n" },
  );
  await assert.rejects(
    fetchHtmlPage(PAGE, page({ fetchFn: record.fetchFn })),
    /robots\.txt disallows \/members\/used/u,
  );
  assert.equal(
    record.urls.includes(`${BASE}/members/used`),
    false,
    "a disallowed destination must not be requested",
  );
});

test("an explicitly declared extra origin is allowed, and only that one", async () => {
  const record = recorder((url) =>
    new URL(url).origin === "https://shop.example.net"
      ? html("<html>moved</html>")
      : redirect("https://shop.example.net/used"),
  );
  const result = await fetchHtmlPage(
    PAGE,
    page({ fetchFn: record.fetchFn, allowedRedirectOrigins: ["https://shop.example.net"] }),
  );
  assert.equal(result, "<html>moved</html>");

  const other = recorder(() => redirect("https://other.example.net/used"));
  await assert.rejects(
    fetchHtmlPage(
      PAGE,
      page({ fetchFn: other.fetchFn, allowedRedirectOrigins: ["https://shop.example.net"] }),
    ),
    (error: unknown) => error instanceof CrawlRedirectRejectedError,
  );
});

test("the relay refuses to follow a redirect rather than re-sending its credential", async () => {
  const seen: { url: string; authorization: string | null }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), authorization: headers.get("authorization") });
    return new Response(null, {
      status: 307,
      headers: { location: "https://elsewhere.test/relay" },
    });
  };
  const relay = createRelayHtmlFetcher({
    relayUrl: "https://relay.test/fetch",
    relayToken: "relay-token-value",
    fetchFn,
  });

  await assert.rejects(
    relay.fetchHtmlPage(PAGE, { userAgent: "HiFiScoutBot/0.1" }),
    (error: unknown) => error instanceof CrawlRedirectRejectedError,
  );
  assert.equal(seen.length, 1, "the relay credential is sent once, to the configured relay only");
  assert.equal(seen[0]?.url, "https://relay.test/fetch");
});

test("a refused destination fails the collection instead of reporting an empty shop", async () => {
  const { db } = migratedSqlite();
  const recording = recordingDatabase(db);
  const plugin = getShopPlugin("home-shokai")!;
  const runId = "crawl:home-shokai:refused-redirect";
  const at = "2026-09-05T00:00:00.000Z";
  const env = {
    DB: recording.db,
    HOME_SHOKAI_REQUEST_DELAY_MS: "0",
  } as unknown as ResumableRuntimeEnv;

  const { session } = await ensureCrawlFetchSession(db, {
    runId,
    shopKey: plugin.key,
    requestedAt: at,
    createdAt: at,
    progressStorage: "d1",
    maxPages: 1,
    pageLimit: 1,
    pages: [
      {
        key: "https://www.homeshokai.jp/itemlist.php?a=2",
        page: "https://www.homeshokai.jp/itemlist.php?a=2",
        ordinal: 0,
      },
    ],
  });

  recording.executed.length = 0;
  const result = await processFetch(
    env,
    plugin,
    session,
    { shopKey: plugin.key, force: true, requestedAt: at, jobId: runId, collectionRunId: runId },
    {
      fetchHtmlPage: async () => {
        throw new CrawlRedirectRejectedError(
          "origin https://evil.test is not allowed for this shop",
        );
      },
    },
  );

  assert.equal(result.kind, "terminal");
  assert.equal(result.result?.status, "failed");
  assert.match(String(result.result?.error), /redirect rejected/u);
  assert.equal(
    recording.executed.some(({ sql }) => /UPDATE\s+products\b/iu.test(sql)),
    false,
  );
  assert.equal((await getCrawlFetchSession(db, runId))?.status, "failed");
});
