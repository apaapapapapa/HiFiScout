import test from "node:test";
import assert from "node:assert/strict";
import { decodeHtmlResponse, fetchHtmlPage } from "../src/crawler/fetch.js";

test("decodes EUC-JP HTML using the declared response charset", async () => {
  const bytes = Uint8Array.from([
    51, 57, 56, 44, 48, 48, 48, 177, 223, 161, 202, 192, 199, 185, 254, 161, 203,
  ]);
  const response = new Response(bytes, {
    headers: { "content-type": "text/html; charset=EUC-JP" },
  });
  assert.equal(await decodeHtmlResponse(response), "398,000円（税込）");
});

test("defaults to UTF-8 when charset is not declared", async () => {
  const response = new Response("中古オーディオ", {
    headers: { "content-type": "text/html" },
  });
  assert.equal(await decodeHtmlResponse(response), "中古オーディオ");
});

test("direct crawl requests carry abort deadlines for robots and listing fetches", async () => {
  const requests: RequestInit[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    requests.push(init || {});
    if (requests.length === 1) return new Response("", { status: 404 });
    return new Response("<html>ok</html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

  const html = await fetchHtmlPage("https://example.com/used", {
    baseUrl: "https://example.com",
    userAgent: "HiFiScoutBot/0.1",
    requestDelayMs: 0,
    fetchFn,
  });

  assert.equal(html, "<html>ok</html>");
  assert.equal(requests.length, 2);
  assert.ok(requests[0]?.signal instanceof AbortSignal);
  assert.ok(requests[1]?.signal instanceof AbortSignal);
});
