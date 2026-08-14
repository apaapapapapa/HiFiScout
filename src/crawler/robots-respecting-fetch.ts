import { getCrawlDelayMs, isPathAllowed } from "./robots.js";
import type { RobotsPolicy } from "./types.js";

const MAX_REDIRECTS = 5;

interface RobotsRespectingFetchOptions {
  userAgent?: string;
  minimumDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function boundedDelay(value: unknown, fallback = 500): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(30_000, Math.max(0, parsed)) : fallback;
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function mergeUserAgent(init: RequestInit = {}, userAgent: string): RequestInit {
  const headers = new Headers(init.headers || {});
  if (!headers.has("user-agent")) headers.set("user-agent", userAgent);
  return { ...init, headers, redirect: "manual" };
}

function redirectLocation(response: Response, currentUrl: string): string {
  if (response.status < 300 || response.status >= 400) return "";
  const location = response.headers.get("location");
  if (!location) return "";
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return "";
  }
}

export function createRobotsRespectingFetch(
  fetchImpl: typeof fetch = globalThis.fetch,
  { userAgent = "HiFiScoutBot/0.1", minimumDelayMs = 500 }: RobotsRespectingFetchOptions = {},
): typeof fetch {
  const policyByOrigin = new Map<string, Promise<RobotsPolicy>>();
  const lastRequestAtByOrigin = new Map<string, number>();
  const minDelay = boundedDelay(minimumDelayMs);

  async function loadPolicy(origin: string): Promise<RobotsPolicy> {
    const cached = policyByOrigin.get(origin);
    if (cached) return cached;
    const promise = (async () => {
      const robotsUrl = new URL("/robots.txt", origin).toString();
      const response = await fetchImpl(robotsUrl, {
        headers: { "user-agent": userAgent },
        redirect: "manual",
      });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`robots.txt temporarily unavailable (${response.status})`);
      }
      if (response.status >= 300 && response.status < 400) {
        return { text: null, status: 404 };
      }
      if (response.status >= 400 && response.status < 500) {
        return { text: null, status: response.status };
      }
      if (!response.ok) return { text: null, status: response.status };
      return { text: await response.text(), status: response.status };
    })();
    policyByOrigin.set(origin, promise);
    try {
      return await promise;
    } catch (error) {
      policyByOrigin.delete(origin);
      throw error;
    }
  }

  async function waitForOrigin(origin: string, robotsText: string | null): Promise<void> {
    const delayMs = Math.max(minDelay, getCrawlDelayMs(robotsText, userAgent));
    const lastRequestAt = lastRequestAtByOrigin.get(origin) || 0;
    const remaining = delayMs - (Date.now() - lastRequestAt);
    if (remaining > 0) await sleep(remaining);
    lastRequestAtByOrigin.set(origin, Date.now());
  }

  return async function robotsRespectingFetch(
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> {
    const initialUrl = requestUrl(input);
    const initial = new URL(initialUrl);
    if (!["http:", "https:"].includes(initial.protocol))
      throw new Error("unsupported_knowledge_source_protocol");
    const allowedOrigin = initial.origin;
    let currentUrl = initial.toString();

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const parsed = new URL(currentUrl);
      if (parsed.origin !== allowedOrigin) {
        return new Response("Cross-origin redirect blocked", {
          status: 403,
          headers: { "x-hifiscout-source-policy": "cross-origin-redirect" },
        });
      }
      const policy = await loadPolicy(parsed.origin);

      if (parsed.pathname === "/robots.txt") {
        return new Response(policy.text || "", {
          status: policy.status || (policy.text == null ? 404 : 200),
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      if (!isPathAllowed(policy.text, currentUrl, userAgent)) {
        return new Response("Blocked by robots.txt", {
          status: 403,
          headers: { "x-hifiscout-robots": "disallow" },
        });
      }

      await waitForOrigin(parsed.origin, policy.text);
      const response = await fetchImpl(currentUrl, mergeUserAgent(init, userAgent));
      const nextUrl = redirectLocation(response, currentUrl);
      if (!nextUrl) return response;
      currentUrl = nextUrl;
    }

    return new Response("Too many redirects", {
      status: 508,
      headers: { "x-hifiscout-source-policy": "redirect-limit" },
    });
  };
}
