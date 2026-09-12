import type {
  AugmentedCrawlError,
  RelayFetcherConfig,
  RelayPage,
  RelayPageOptions,
} from "./types.js";
import { decodeHtmlResponse } from "./fetch.js";
import {
  CRAWL_REDIRECT_REJECTED_CODE,
  CrawlRedirectRejectedError,
  isRedirectStatus,
} from "./redirects.js";
import {
  CRAWL_MAX_HTML_RESPONSE_BYTES,
  CRAWL_MAX_RELAY_ERROR_BYTES,
  CRAWL_MAX_RELAY_JSON_BYTES,
  readBoundedResponseText,
  readLimitedResponseText,
} from "./response-limits.js";

const RELAY_HTTP_TIMEOUT_MS = 30_000;

export interface RelayFetchPermit {
  permit: string;
  targetUrl: string;
  requestedUserAgent: string;
  effectiveUserAgent: string;
  effectiveDelayMs: number;
  issuedAtMs: number;
  notBeforeMs: number;
  expiresAtMs: number;
}

function configured(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function upstreamError(status: number): AugmentedCrawlError {
  const error: AugmentedCrawlError = new Error(
    status === 403 || status === 429
      ? `crawl blocked with HTTP ${status}`
      : `crawl failed with HTTP ${status}`,
  );
  error.status = status;
  return error;
}

function relayError(status: number, detail = ""): AugmentedCrawlError {
  const error: AugmentedCrawlError = new Error(
    `relay failed with HTTP ${status}${detail ? `: ${detail}` : ""}`,
  );
  error.relayStatus = status;
  if (/robots_disallowed/i.test(detail)) error.code = "robots_disallowed";
  if (/permit_not_ready/i.test(detail)) error.code = "relay_permit_not_ready";
  if (/permit_expired/i.test(detail)) error.code = "relay_permit_expired";
  if (/invalid_permit|permit_binding_mismatch|permit_profile_changed/i.test(detail)) {
    error.code = "relay_permit_invalid";
  }
  if (/redirect_rejected/i.test(detail)) error.code = CRAWL_REDIRECT_REJECTED_CODE;
  return error;
}

/** `createRelayHtmlFetcher` always resolves `fetchFn`, so the internal request path requires it. */
type RelayRequestContext = RelayFetcherConfig & { fetchFn: typeof fetch };

/** The relay response together with the deadline that must also bound reading its body. */
interface RelayHttpResponse {
  response: Response;
  deadline: AbortSignal;
}

async function relayResponse(
  { relayUrl, relayToken, fetchFn }: RelayRequestContext,
  body: Record<string, unknown>,
  accept: string,
): Promise<RelayHttpResponse> {
  if (!configured(relayUrl)) throw new Error("relay URL is not configured");
  if (!configured(relayToken)) throw new Error("relay token is not configured");

  const deadline = AbortSignal.timeout(RELAY_HTTP_TIMEOUT_MS);
  // The relay endpoint is ours and never redirects. Following one would re-send the relay bearer
  // token to whatever destination the response named, so a redirect is refused outright rather than
  // validated: there is no second address this credential belongs to.
  const response = await fetchFn(relayUrl.trim(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${relayToken.trim()}`,
      Accept: accept,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: deadline,
  });
  if (isRedirectStatus(response.status)) {
    await response.body?.cancel().catch(() => {});
    throw new CrawlRedirectRejectedError(
      `relay endpoint answered HTTP ${response.status}; the relay credential is never forwarded`,
    );
  }

  const upstreamStatus = Number.parseInt(
    response.headers.get("x-hifiscout-upstream-status") || "",
    10,
  );
  if (!response.ok && !Number.isFinite(upstreamStatus)) {
    let detail = "";
    try {
      // Only the leading diagnostic matters, and it is trimmed to 200 characters regardless; a relay
      // that answers a failure with an unbounded body must not be buffered to produce it.
      const read = await readBoundedResponseText(response, {
        maxBytes: CRAWL_MAX_RELAY_ERROR_BYTES,
        signal: deadline,
      });
      detail = read.text.replace(/\s+/g, " ").trim().slice(0, 200);
    } catch {
      // Keep the status-only error when the relay body cannot be read.
    }
    if (response.status === 401 || response.status === 403) {
      const error: AugmentedCrawlError = new Error(
        `relay authentication failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
      error.relayStatus = response.status;
      if (/invalid_permit/i.test(detail)) error.code = "relay_permit_invalid";
      throw error;
    }
    throw relayError(response.status, detail);
  }
  return { response, deadline };
}

async function relayPageFromResponse({
  response,
  deadline,
}: RelayHttpResponse): Promise<RelayPage> {
  const upstreamStatus = Number.parseInt(
    response.headers.get("x-hifiscout-upstream-status") || "",
    10,
  );
  const status = Number.isFinite(upstreamStatus) ? upstreamStatus : response.status;
  const contentType = response.headers.get("content-type") || "";
  // The relay returns the seller body verbatim, so the same ceiling that protects the direct
  // transport applies here; the relay is a different route to the same untrusted bytes.
  const body = contentType.includes("text/html")
    ? await decodeHtmlResponse(response, { signal: deadline })
    : await readLimitedResponseText(response, {
        maxBytes: CRAWL_MAX_HTML_RESPONSE_BYTES,
        signal: deadline,
      });
  return { status, contentType, body };
}

async function requestRelayPage(
  relay: RelayRequestContext,
  url: string,
  { userAgent, requestDelayMs }: RelayPageOptions = {},
): Promise<RelayPage> {
  const relayed = await relayResponse(
    relay,
    {
      url,
      userAgent,
      requestDelayMs: Number(requestDelayMs) || 0,
    },
    "text/html,application/xhtml+xml",
  );
  return relayPageFromResponse(relayed);
}

function parseRelayFetchPermit(value: unknown): RelayFetchPermit {
  if (!isRecord(value)) throw new Error("relay PREPARE returned an invalid response");
  const fields = {
    permit: value.permit,
    targetUrl: value.targetUrl,
    requestedUserAgent: value.requestedUserAgent,
    effectiveUserAgent: value.effectiveUserAgent,
    effectiveDelayMs: value.effectiveDelayMs,
    issuedAtMs: value.issuedAtMs,
    notBeforeMs: value.notBeforeMs,
    expiresAtMs: value.expiresAtMs,
  };
  if (
    typeof fields.permit !== "string" ||
    !fields.permit ||
    typeof fields.targetUrl !== "string" ||
    !fields.targetUrl ||
    typeof fields.requestedUserAgent !== "string" ||
    !fields.requestedUserAgent ||
    typeof fields.effectiveUserAgent !== "string" ||
    !fields.effectiveUserAgent ||
    !Number.isFinite(fields.effectiveDelayMs) ||
    !Number.isFinite(fields.issuedAtMs) ||
    !Number.isFinite(fields.notBeforeMs) ||
    !Number.isFinite(fields.expiresAtMs)
  ) {
    throw new Error("relay PREPARE returned an invalid response");
  }
  return fields as RelayFetchPermit;
}

/**
 * Relay Phase 4 control-plane handshake. The Lambda remains the pacing/robots authority, but it
 * returns immediately with a signed opaque permit so a Durable Object can move the wait into an
 * Alarm instead of keeping either runtime active.
 */
export async function prepareRelayFetchPermit(
  config: RelayFetcherConfig,
  url: string,
  { userAgent, requestDelayMs }: RelayPageOptions = {},
): Promise<RelayFetchPermit> {
  const relay: RelayRequestContext = { ...config, fetchFn: config.fetchFn || fetch };
  const { response, deadline } = await relayResponse(
    relay,
    {
      operation: "prepare",
      url,
      userAgent,
      requestDelayMs: Number(requestDelayMs) || 0,
    },
    "application/json",
  );
  const permitJson = await readLimitedResponseText(response, {
    maxBytes: CRAWL_MAX_RELAY_JSON_BYTES,
    signal: deadline,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(permitJson) as unknown;
  } catch {
    throw new Error("relay PREPARE returned an invalid response");
  }
  return parseRelayFetchPermit(parsed);
}

export async function fetchPreparedRelayPage(
  config: RelayFetcherConfig,
  permit: RelayFetchPermit,
  url: string,
  { userAgent }: RelayPageOptions = {},
): Promise<RelayPage> {
  if (url !== permit.targetUrl) throw new Error("relay permit target mismatch");
  if (userAgent != null && userAgent !== permit.requestedUserAgent) {
    throw new Error("relay permit user-agent mismatch");
  }
  const relay: RelayRequestContext = { ...config, fetchFn: config.fetchFn || fetch };
  const relayed = await relayResponse(
    relay,
    {
      operation: "fetch",
      permit: permit.permit,
      url: permit.targetUrl,
      userAgent: permit.requestedUserAgent,
    },
    "text/html,application/xhtml+xml",
  );
  return relayPageFromResponse(relayed);
}

export async function fetchPreparedRelayHtmlPage(
  config: RelayFetcherConfig,
  permit: RelayFetchPermit,
  url: string,
  options: RelayPageOptions = {},
): Promise<string> {
  const page = await fetchPreparedRelayPage(config, permit, url, options);
  if (page.status < 200 || page.status >= 300) throw upstreamError(page.status);
  if (!page.contentType.includes("text/html")) {
    throw new Error(`unexpected relay content type: ${page.contentType}`);
  }
  return page.body;
}

export function createRelayHtmlFetcher({
  relayUrl,
  relayToken,
  fetchFn = fetch,
}: RelayFetcherConfig = {}) {
  const relay: RelayRequestContext = { relayUrl, relayToken, fetchFn };
  return {
    async fetchPage(url: string, options: RelayPageOptions = {}): Promise<RelayPage> {
      return requestRelayPage(relay, url, options);
    },

    async fetchHtmlPage(url: string, options: RelayPageOptions = {}): Promise<string> {
      const page = await requestRelayPage(relay, url, options);
      if (page.status < 200 || page.status >= 300) throw upstreamError(page.status);
      if (!page.contentType.includes("text/html")) {
        throw new Error(`unexpected relay content type: ${page.contentType}`);
      }
      return page.body;
    },

    async close(): Promise<void> {},
  };
}
