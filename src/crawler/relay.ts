import { decodeHtmlResponse } from "./fetch.js";

function configured(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function upstreamError(status) {
  const error = new Error(
    status === 403 || status === 429
      ? `crawl blocked with HTTP ${status}`
      : `crawl failed with HTTP ${status}`,
  );
  error.status = status;
  return error;
}

function relayError(status, detail = "") {
  const error = new Error(`relay failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
  error.relayStatus = status;
  if (/robots_disallowed/i.test(detail)) error.code = "robots_disallowed";
  return error;
}

async function requestRelayPage(
  { relayUrl, relayToken, fetchFn },
  url,
  { userAgent, requestDelayMs } = {},
) {
  if (!configured(relayUrl)) throw new Error("relay URL is not configured");
  if (!configured(relayToken)) throw new Error("relay token is not configured");

  const response = await fetchFn(relayUrl.trim(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${relayToken.trim()}`,
      Accept: "text/html,application/xhtml+xml",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      userAgent,
      requestDelayMs: Number(requestDelayMs) || 0,
    }),
    redirect: "follow",
  });

  const upstreamStatus = Number.parseInt(
    response.headers.get("x-hifiscout-upstream-status") || "",
    10,
  );
  if (!response.ok && !Number.isFinite(upstreamStatus)) {
    let detail = "";
    try {
      detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 200);
    } catch {
      // Keep the status-only error when the relay body cannot be read.
    }
    if (response.status === 401 || response.status === 403) {
      const error = new Error(`relay authentication failed with HTTP ${response.status}`);
      error.relayStatus = response.status;
      throw error;
    }
    throw relayError(response.status, detail);
  }

  const status = Number.isFinite(upstreamStatus) ? upstreamStatus : response.status;
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("text/html")
    ? await decodeHtmlResponse(response)
    : await response.text();

  return { status, contentType, body };
}

export function createRelayHtmlFetcher({ relayUrl, relayToken, fetchFn = fetch } = {}) {
  const relay = { relayUrl, relayToken, fetchFn };
  return {
    async fetchPage(url, options = {}) {
      return requestRelayPage(relay, url, options);
    },

    async fetchHtmlPage(url, options = {}) {
      const page = await requestRelayPage(relay, url, options);
      if (page.status < 200 || page.status >= 300) throw upstreamError(page.status);
      if (!page.contentType.includes("text/html")) {
        throw new Error(`unexpected relay content type: ${page.contentType}`);
      }
      return page.body;
    },

    async close() {},
  };
}
