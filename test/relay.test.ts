import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  createRelayHtmlFetcher,
  fetchPreparedRelayHtmlPage,
  prepareRelayFetchPermit,
} from "../src/crawler/relay.js";
import { isRecord } from "../src/types.js";

test("relay transport forwards target, delay and crawler identity", async () => {
  let requestedUrl = "";
  let requestedOptions: RequestInit = {};
  const fetcher = createRelayHtmlFetcher({
    relayUrl: "https://relay.example/",
    relayToken: "secret-token",
    fetchFn: async (url, options) => {
      requestedUrl = String(url);
      requestedOptions = options || {};
      return new Response("<html>ok</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  const html = await fetcher.fetchHtmlPage("https://www.audiounion.jp/st/new_arrival_used.html", {
    userAgent: "HiFiScoutBot/0.1",
    requestDelayMs: 10_000,
  });

  assert.equal(html, "<html>ok</html>");
  assert.equal(requestedUrl, "https://relay.example/");
  assert.equal(new Headers(requestedOptions.headers).get("authorization"), "Bearer secret-token");
  assert.ok(requestedOptions.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(requestedOptions.body)), {
    url: "https://www.audiounion.jp/st/new_arrival_used.html",
    userAgent: "HiFiScoutBot/0.1",
    requestDelayMs: 10_000,
  });
});

test("relay PREPARE returns scheduler metadata without seller HTML", async () => {
  let requestedOptions: RequestInit = {};
  const permit = await prepareRelayFetchPermit(
    {
      relayUrl: "https://relay.example/",
      relayToken: "secret-token",
      fetchFn: async (_url, options) => {
        requestedOptions = options || {};
        return Response.json({
          operation: "prepared",
          permit: "opaque.signed",
          targetUrl: "https://www.audiounion.jp/st/new_arrival_used.html",
          requestedUserAgent: "HiFiScoutBot/0.1",
          effectiveUserAgent: "HiFiScoutBot/0.1",
          effectiveDelayMs: 12_000,
          issuedAtMs: 1_000,
          notBeforeMs: 13_000,
          expiresAtMs: 313_000,
        });
      },
    },
    "https://www.audiounion.jp/st/new_arrival_used.html",
    { userAgent: "HiFiScoutBot/0.1", requestDelayMs: 5_000 },
  );

  assert.deepEqual(permit, {
    permit: "opaque.signed",
    targetUrl: "https://www.audiounion.jp/st/new_arrival_used.html",
    requestedUserAgent: "HiFiScoutBot/0.1",
    effectiveUserAgent: "HiFiScoutBot/0.1",
    effectiveDelayMs: 12_000,
    issuedAtMs: 1_000,
    notBeforeMs: 13_000,
    expiresAtMs: 313_000,
  });
  assert.deepEqual(JSON.parse(String(requestedOptions.body)), {
    operation: "prepare",
    url: "https://www.audiounion.jp/st/new_arrival_used.html",
    userAgent: "HiFiScoutBot/0.1",
    requestDelayMs: 5_000,
  });
});

test("relay FETCH exchanges the exact prepared URL and UA for HTML", async () => {
  const bodies: unknown[] = [];
  const html = await fetchPreparedRelayHtmlPage(
    {
      relayUrl: "https://relay.example/",
      relayToken: "secret-token",
      fetchFn: async (_url, options) => {
        bodies.push(JSON.parse(String(options?.body)));
        return new Response("<html>prepared</html>", {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-hifiscout-upstream-status": "200",
          },
        });
      },
    },
    {
      permit: "opaque.signed",
      targetUrl: "https://www.audiounion.jp/st/new_arrival_used.html",
      requestedUserAgent: "HiFiScoutBot/0.1",
      effectiveUserAgent: "HiFiScoutBot/0.1",
      effectiveDelayMs: 10_000,
      issuedAtMs: 1_000,
      notBeforeMs: 11_000,
      expiresAtMs: 311_000,
    },
    "https://www.audiounion.jp/st/new_arrival_used.html",
    { userAgent: "HiFiScoutBot/0.1" },
  );

  assert.equal(html, "<html>prepared</html>");
  assert.deepEqual(bodies, [
    {
      operation: "fetch",
      permit: "opaque.signed",
      url: "https://www.audiounion.jp/st/new_arrival_used.html",
      userAgent: "HiFiScoutBot/0.1",
    },
  ]);
});

test("relay FETCH refuses local permit URL or UA substitution", async () => {
  const permit = {
    permit: "opaque.signed",
    targetUrl: "https://www.audiounion.jp/st/new_arrival_used.html",
    requestedUserAgent: "HiFiScoutBot/0.1",
    effectiveUserAgent: "HiFiScoutBot/0.1",
    effectiveDelayMs: 10_000,
    issuedAtMs: 1_000,
    notBeforeMs: 11_000,
    expiresAtMs: 311_000,
  };
  const config = {
    relayUrl: "https://relay.example/",
    relayToken: "secret-token",
    fetchFn: async () => {
      throw new Error("relay must not be called");
    },
  };

  await assert.rejects(
    fetchPreparedRelayHtmlPage(config, permit, "https://www.hifido.co.jp/?L=50&LNG=J&O=0&OD=0"),
    /relay permit target mismatch/,
  );
  await assert.rejects(
    fetchPreparedRelayHtmlPage(config, permit, permit.targetUrl, { userAgent: "OtherBot/1.0" }),
    /relay permit user-agent mismatch/,
  );
});

test("relay transport preserves upstream crawl status", async () => {
  const fetcher = createRelayHtmlFetcher({
    relayUrl: "https://relay.example/",
    relayToken: "secret-token",
    fetchFn: async () =>
      new Response("not found", {
        status: 404,
        headers: {
          "content-type": "text/plain",
          "x-hifiscout-upstream-status": "404",
        },
      }),
  });

  await assert.rejects(
    fetcher.fetchHtmlPage("https://www.audiounion.jp/st/new_arrival_used.html"),
    /crawl failed with HTTP 404/,
  );
});

test("relay status-aware fetch returns upstream 404 without throwing", async () => {
  const fetcher = createRelayHtmlFetcher({
    relayUrl: "https://relay.example/",
    relayToken: "secret-token",
    fetchFn: async () =>
      new Response("<html>missing</html>", {
        status: 404,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-hifiscout-upstream-status": "404",
        },
      }),
  });

  const page = await fetcher.fetchPage("https://www.audiounion.jp/ct/detail/used/123/");
  assert.equal(page.status, 404);
  assert.equal(page.contentType, "text/html; charset=utf-8");
  assert.equal(page.body, "<html>missing</html>");
});

test("relay status-aware fetch distinguishes robots rejection from upstream status", async () => {
  const fetcher = createRelayHtmlFetcher({
    relayUrl: "https://relay.example/",
    relayToken: "secret-token",
    fetchFn: async () =>
      new Response('{"error":"robots_disallowed"}', {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    fetcher.fetchPage("https://www.audiounion.jp/ct/detail/used/123/"),
    (error) => isRecord(error) && error.relayStatus === 409 && error.code === "robots_disallowed",
  );
});

test("relay transport refuses missing credentials", async () => {
  const fetcher = createRelayHtmlFetcher({ relayUrl: "", relayToken: "" });
  await assert.rejects(
    fetcher.fetchHtmlPage("https://www.audiounion.jp/st/new_arrival_used.html"),
    /relay URL is not configured/,
  );
});