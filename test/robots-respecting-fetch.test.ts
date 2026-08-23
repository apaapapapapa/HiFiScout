import { test } from "vitest";
import assert from "node:assert/strict";

import { createRobotsRespectingFetch } from "../src/crawler/robots-respecting-fetch.js";

test("knowledge source fetch blocks a path disallowed by robots.txt", async () => {
  const requested: string[] = [];
  const baseFetch: typeof fetch = async (url) => {
    requested.push(String(url));
    if (String(url) === "https://example.com/robots.txt") {
      return new Response("User-agent: HiFiScoutBot\nDisallow: /private", { status: 200 });
    }
    return new Response("should not fetch", { status: 200 });
  };
  const fetchImpl = createRobotsRespectingFetch(baseFetch, {
    userAgent: "HiFiScoutBot/0.1",
    minimumDelayMs: 0,
  });

  const response = await fetchImpl("https://example.com/private/product");
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("x-hifiscout-robots"), "disallow");
  assert.deepEqual(requested, ["https://example.com/robots.txt"]);
});

test("knowledge source fetch caches robots policy and allows permitted paths", async () => {
  const requested: string[] = [];
  const baseFetch: typeof fetch = async (url) => {
    requested.push(String(url));
    if (String(url) === "https://example.com/robots.txt") {
      return new Response("User-agent: *\nDisallow: /private\nAllow: /public", { status: 200 });
    }
    return new Response("ok", { status: 200 });
  };
  const fetchImpl = createRobotsRespectingFetch(baseFetch, {
    userAgent: "HiFiScoutBot/0.1",
    minimumDelayMs: 0,
  });

  assert.equal((await fetchImpl("https://example.com/public/a")).status, 200);
  assert.equal((await fetchImpl("https://example.com/public/b")).status, 200);
  assert.equal(requested.filter((url) => url.endsWith("/robots.txt")).length, 1);
});

test("same-origin redirects are followed under the same robots policy", async () => {
  const requested: string[] = [];
  const baseFetch: typeof fetch = async (url) => {
    requested.push(String(url));
    if (String(url) === "https://example.com/robots.txt")
      return new Response("User-agent: *\nAllow: /", { status: 200 });
    if (String(url) === "https://example.com/start")
      return new Response("", { status: 302, headers: { location: "/final" } });
    if (String(url) === "https://example.com/final") return new Response("ok", { status: 200 });
    return new Response("not found", { status: 404 });
  };
  const fetchImpl = createRobotsRespectingFetch(baseFetch, {
    userAgent: "HiFiScoutBot/0.1",
    minimumDelayMs: 0,
  });

  const response = await fetchImpl("https://example.com/start");
  assert.equal(response.status, 200);
  assert.equal(new Set(requested).has("https://example.com/final"), true);
});

test("cross-origin redirects are blocked before the destination is fetched", async () => {
  const requested: string[] = [];
  const baseFetch: typeof fetch = async (url) => {
    requested.push(String(url));
    if (String(url) === "https://example.com/robots.txt")
      return new Response("User-agent: *\nAllow: /", { status: 200 });
    if (String(url) === "https://example.com/start")
      return new Response("", {
        status: 302,
        headers: { location: "https://outside.example/final" },
      });
    return new Response("should not fetch", { status: 200 });
  };
  const fetchImpl = createRobotsRespectingFetch(baseFetch, {
    userAgent: "HiFiScoutBot/0.1",
    minimumDelayMs: 0,
  });

  const response = await fetchImpl("https://example.com/start");
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("x-hifiscout-source-policy"), "cross-origin-redirect");
  assert.ok(!requested.some((url) => url.startsWith("https://outside.example/")));
});

test("temporary robots errors fail closed for knowledge source requests", async () => {
  const baseFetch: typeof fetch = async (url) => {
    if (String(url).endsWith("/robots.txt")) return new Response("", { status: 503 });
    return new Response("should not fetch", { status: 200 });
  };
  const fetchImpl = createRobotsRespectingFetch(baseFetch, {
    userAgent: "HiFiScoutBot/0.1",
    minimumDelayMs: 0,
  });

  await assert.rejects(
    () => fetchImpl("https://example.com/product"),
    /robots\.txt temporarily unavailable/,
  );
});
