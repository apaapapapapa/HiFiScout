import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { decodeHtmlResponse, fetchHtmlPage } from "../src/crawler/fetch.js";
import { fetchRobotsPolicy, isPathAllowed } from "../src/crawler/robots.js";
import {
  CRAWL_MAX_ROBOTS_RESPONSE_BYTES,
  CrawlResponseTooLargeError,
  readBoundedResponseText,
  readLimitedResponseText,
} from "../src/crawler/response-limits.js";
import { processFetch } from "../src/crawler/resumable-page-steps.js";
import type { ResumableRuntimeEnv } from "../src/crawler/resumable-queue-contract.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import {
  ensureCrawlFetchSession,
  getCrawlFetchSession,
} from "../src/db/crawl-fetch-session-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { recordingDatabase } from "./helpers/query-plan.js";

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

interface StreamRecord {
  cancelled: boolean;
  delivered: number;
}

/** A body delivered in chunks, with no `Content-Length`, that records cancellation. */
function chunkedResponse(
  chunks: Uint8Array[],
  init: ResponseInit = {},
): { response: Response; record: StreamRecord } {
  const record: StreamRecord = { cancelled: false, delivered: 0 };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        record.delivered += chunk.byteLength;
        controller.enqueue(chunk);
      }
      controller.close();
    },
    cancel() {
      record.cancelled = true;
    },
  });
  return { response: new Response(stream, init), record };
}

function filler(byteLength: number, character = "a"): Uint8Array {
  return new TextEncoder().encode(character.repeat(byteLength));
}

test("a body inside the ceiling is decoded unchanged", async () => {
  const { response } = chunkedResponse([new TextEncoder().encode("<html>中古</html>")], {
    headers: HTML_HEADERS,
  });
  assert.equal(await decodeHtmlResponse(response, { maxBytes: 1024 }), "<html>中古</html>");
});

test("a body exactly at the ceiling is accepted", async () => {
  const { response, record } = chunkedResponse([filler(64)]);
  const text = await readLimitedResponseText(response, { maxBytes: 64 });
  assert.equal(text.length, 64);
  assert.equal(record.cancelled, false);
});

test("a body one byte over the ceiling is refused", async () => {
  const { response } = chunkedResponse([filler(65)]);
  await assert.rejects(
    readLimitedResponseText(response, { maxBytes: 64 }),
    (error: unknown) => error instanceof CrawlResponseTooLargeError,
  );
});

test("an overflow spread across chunks is refused and the reader is cancelled", async () => {
  // No single chunk exceeds the ceiling; only their sum does.
  const { response, record } = chunkedResponse([filler(40), filler(40), filler(40)]);
  await assert.rejects(
    readLimitedResponseText(response, { maxBytes: 64 }),
    (error: unknown) => error instanceof CrawlResponseTooLargeError,
  );
  assert.equal(record.cancelled, true, "the oversized remainder must not be drained");
});

test("the ceiling holds without a Content-Length header", async () => {
  const { response } = chunkedResponse([filler(200)]);
  assert.equal(response.headers.get("content-length"), null);
  await assert.rejects(
    readLimitedResponseText(response, { maxBytes: 64 }),
    (error: unknown) => error instanceof CrawlResponseTooLargeError,
  );
});

test("a declared length over the ceiling is refused before the body is read", async () => {
  const { response, record } = chunkedResponse([filler(8)], {
    headers: { "content-length": "9000" },
  });
  await assert.rejects(
    readLimitedResponseText(response, { maxBytes: 64 }),
    (error: unknown) => error instanceof CrawlResponseTooLargeError,
  );
  assert.equal(record.cancelled, true);
});

test("a small compressed length does not license a large decompressed body", async () => {
  // `fetch()` hands back an already-decompressed body, so the counted bytes are the decoded ones
  // even when the transfer advertised a far smaller compressed size.
  const { response } = chunkedResponse([filler(4096)], {
    headers: { ...HTML_HEADERS, "content-length": "48" },
  });
  await assert.rejects(
    decodeHtmlResponse(response, { maxBytes: 1024 }),
    (error: unknown) => error instanceof CrawlResponseTooLargeError,
  );
});

test("a body that stalls mid-stream ends with the request deadline", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.enqueue(filler(8));
      // Never closed: the remaining body never arrives.
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(stream, { headers: HTML_HEADERS });
  const read = decodeHtmlResponse(response, { maxBytes: 1024, signal: controller.signal });
  setTimeout(() => controller.abort(new Error("crawl deadline")), 5);
  await assert.rejects(read, /crawl deadline/u);
  assert.equal(cancelled, true);
});

test("multi-byte characters split across chunks still decode with the declared charset", async () => {
  // "398,000円（税込）" in EUC-JP, cut inside the first multi-byte character.
  const bytes = Uint8Array.from([
    51, 57, 56, 44, 48, 48, 48, 177, 223, 161, 202, 192, 199, 185, 254, 161, 203,
  ]);
  const { response } = chunkedResponse([bytes.subarray(0, 8), bytes.subarray(8)], {
    headers: { "content-type": "text/html; charset=EUC-JP" },
  });
  assert.equal(await decodeHtmlResponse(response), "398,000円（税込）");
});

test("an unknown charset label still falls back to UTF-8", async () => {
  const { response } = chunkedResponse([new TextEncoder().encode("中古オーディオ")], {
    headers: { "content-type": "text/html; charset=x-not-a-charset" },
  });
  assert.equal(await decodeHtmlResponse(response), "中古オーディオ");
});

test("fetchHtmlPage refuses an oversized page instead of returning partial HTML", async () => {
  const fetchFn: typeof fetch = async (input) => {
    if (String(input).endsWith("/robots.txt")) return new Response("", { status: 404 });
    const { response } = chunkedResponse([filler(600), filler(600)], { headers: HTML_HEADERS });
    return response;
  };

  await assert.rejects(
    fetchHtmlPage("https://example.com/used", {
      baseUrl: "https://example.com",
      userAgent: "HiFiScoutBot/0.1",
      requestDelayMs: 0,
      fetchFn,
      maxResponseBytes: 1000,
    }),
    (error: unknown) => error instanceof CrawlResponseTooLargeError,
  );
});

test("fetchHtmlPage accepts a page exactly at its ceiling", async () => {
  const fetchFn: typeof fetch = async (input) => {
    if (String(input).endsWith("/robots.txt")) return new Response("", { status: 404 });
    const { response } = chunkedResponse([filler(1000)], { headers: HTML_HEADERS });
    return response;
  };

  const html = await fetchHtmlPage("https://example.com/used", {
    baseUrl: "https://example.com",
    userAgent: "HiFiScoutBot/0.1",
    requestDelayMs: 0,
    fetchFn,
    maxResponseBytes: 1000,
  });
  assert.equal(html.length, 1000);
});

test("fetchHtmlPage gives the page body the same deadline as the request", async () => {
  const fetchFn: typeof fetch = async (input) => {
    if (String(input).endsWith("/robots.txt")) return new Response("", { status: 404 });
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(filler(8));
      },
    });
    return new Response(stream, { headers: HTML_HEADERS });
  };

  await assert.rejects(
    fetchHtmlPage("https://example.com/used", {
      baseUrl: "https://example.com",
      userAgent: "HiFiScoutBot/0.1",
      requestDelayMs: 0,
      fetchFn,
      timeoutMs: 10,
    }),
    (error: unknown) => error instanceof Error && /timed out|abort/iu.test(error.message),
  );
});

test("robots.txt is truncated at a line boundary rather than failing the crawl", async () => {
  const oversized = `User-agent: *\nDisallow: /private\n${"# padding\n".repeat(
    Math.ceil(CRAWL_MAX_ROBOTS_RESPONSE_BYTES / 10),
  )}Disallow: /late`;
  const fetchFn: typeof fetch = async () =>
    new Response(oversized, { headers: { "content-type": "text/plain" } });

  const policy = await fetchRobotsPolicy(fetchFn, "https://example.com", "HiFiScoutBot/0.1");
  assert.ok(policy);
  assert.ok(policy.length <= CRAWL_MAX_ROBOTS_RESPONSE_BYTES);
  assert.ok(policy.includes("Disallow: /private"));
  assert.ok(policy.endsWith("\n"), "a partial trailing rule is dropped");
  assert.ok(!policy.includes("Disallow: /late"));
});

test("a truncated read reports the cut instead of silently shortening the body", async () => {
  const { response } = chunkedResponse([filler(100)]);
  const read = await readBoundedResponseText(response, { maxBytes: 40 });
  assert.equal(read.truncated, true);
  assert.equal(read.text.length, 40);
});

test("an oversized page fails the collection instead of reporting an empty shop", async () => {
  // A size refusal must reach the same terminal failure path as any other fetch error. Reporting it
  // as a successful crawl with no items is what would mark the shop's existing products inactive.
  const { db } = migratedSqlite();
  const recording = recordingDatabase(db);
  const plugin = getShopPlugin("home-shokai")!;
  const runId = "crawl:home-shokai:oversized-page";
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
        throw new CrawlResponseTooLargeError(1000);
      },
    },
  );

  assert.equal(result.kind, "terminal");
  assert.equal(result.result?.status, "failed");
  assert.match(String(result.result?.error), /exceeded the 1000 byte limit/u);
  assert.equal(
    recording.executed.some(({ sql }) => /UPDATE\s+products\b/iu.test(sql)),
    false,
    "a refused body must never reach the product deactivation path",
  );
  assert.equal((await getCrawlFetchSession(db, runId))?.status, "failed");
});

test("an oversized robots.txt keeps its leading rules even when Content-Length declares the full size", async () => {
  // A truthful header must not short-circuit a truncating read: dropping the permitted prefix would
  // hand back an empty policy, and an empty policy allows every path.
  const oversized = `User-agent: *\nDisallow: /private\n${"# padding\n".repeat(
    Math.ceil(CRAWL_MAX_ROBOTS_RESPONSE_BYTES / 10),
  )}`;
  const fetchFn: typeof fetch = async () =>
    new Response(oversized, {
      headers: {
        "content-type": "text/plain",
        "content-length": String(new TextEncoder().encode(oversized).byteLength),
      },
    });

  const policy = await fetchRobotsPolicy(fetchFn, "https://example.com", "HiFiScoutBot/0.1");
  assert.ok(policy?.includes("Disallow: /private"));
  assert.equal(
    isPathAllowed(policy, "https://example.com/private/page", "HiFiScoutBot/0.1"),
    false,
  );
});

test("a body measured in bytes is refused even when its character count fits", async () => {
  // Japanese text is three UTF-8 bytes per character, so a code-unit comparison would let a body
  // three times over the ceiling through.
  const japanese = "中".repeat(400);
  const { response } = chunkedResponse([new TextEncoder().encode(japanese)], {
    headers: HTML_HEADERS,
  });
  await assert.rejects(
    decodeHtmlResponse(response, { maxBytes: 600 }),
    (error: unknown) => error instanceof CrawlResponseTooLargeError,
  );
});
