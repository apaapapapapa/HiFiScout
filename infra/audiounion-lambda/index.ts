import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventHeaders, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

/**
 * One header record for every direction: the response branches below build
 * different key sets, and the outbound request profiles do the same.
 */
type RelayHeaders = Record<string, string>;

/**
 * The Lambda Function URL event fields this relay reads. `APIGatewayProxyEventV2`
 * is assignable to it, and so are the hand-built events in the unit tests.
 */
interface RelayEvent {
  headers?: APIGatewayProxyEventHeaders;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

/** Environment variables the relay reads. `process.env` is assignable to it. */
interface RelayEnv {
  RELAY_TOKEN?: string;
  RELAY_PERMIT_SECRET?: string;
  AUDIOUNION_ENTRY_URL?: string;
  CRAWLER_USER_AGENT?: string;
  HIFIDO_USER_AGENT?: string;
  MIN_REQUEST_DELAY_MS?: string;
  AWS_REGION?: string;
}

/** The `Response` surface the relay consumes; the global `Response` satisfies it. */
interface RelayFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface RelayFetchInit {
  headers: RelayHeaders;
  redirect: "follow";
}

type RelayFetch = (url: string, init: RelayFetchInit) => Promise<RelayFetchResponse>;

type RelaySleep = (ms: number) => Promise<unknown>;

/** Structured Function URL response, narrowed to the fields this relay always sets. */
interface RelayResponse extends APIGatewayProxyStructuredResultV2 {
  statusCode: number;
  headers: RelayHeaders;
  body: string;
  isBase64Encoded: boolean;
}

/** Untrusted request payload. */
interface RelayRequestBody {
  operation?: unknown;
  url?: unknown;
  userAgent?: unknown;
  requestDelayMs?: unknown;
  permit?: unknown;
}

interface RobotsRule {
  type: "allow" | "disallow";
  path: string;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds: number | null;
}

interface RelayRequestProfile {
  userAgent: string;
  headers: RelayHeaders;
}

interface RelayPermitClaims {
  version: 1;
  targetUrl: string;
  requestedUserAgent: string;
  profileUserAgent: string;
  issuedAtMs: number;
  notBeforeMs: number;
  expiresAtMs: number;
  nonce: string;
}

interface CreateHandlerOptions {
  fetchFn?: RelayFetch;
  sleepFn?: RelaySleep;
  env?: RelayEnv;
  nowFn?: () => number;
  nonceFn?: () => string;
}

type RelayHandler = (event?: RelayEvent) => Promise<RelayResponse>;

const DEFAULT_ENTRY_URL = "https://www.audiounion.jp/st/new_arrival_used.html";
const DEFAULT_USER_AGENT = "HiFiScoutBot/0.1 (+https://github.com/apaapapapapa/HiFiScout)";
const DEFAULT_HIFIDO_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 HiFiScoutBot/0.1 (+https://github.com/apaapapapapa/HiFiScout)";
const DEFAULT_MIN_DELAY_MS = 10_000;
const RELAY_PERMIT_VERSION = 1 as const;
const RELAY_PERMIT_TTL_MS = 5 * 60_000;
const MAX_PERMIT_LENGTH = 4096;
const PERMIT_SIGNING_CONTEXT = "hifiscout-relay-permit-v1:";
const AUDIOUNION_HOST = "www.audiounion.jp";
const HIFIDO_HOST = "www.hifido.co.jp";
const HIFIDO_ALLOWED_QUERY_KEYS = new Set(["L", "LNG", "O", "OD"]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Narrows a `JSON.parse` result to a plain keyed object; arrays are rejected. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(
  statusCode: number,
  body: Record<string, unknown>,
  headers: RelayHeaders = {},
): RelayResponse {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function requestHeader(event: RelayEvent, name: string): string {
  const headers = event?.headers || {};
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(value ?? "");
  }
  return "";
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodeRequestBody(event: RelayEvent): RelayRequestBody {
  const raw = event?.body || "";
  const decoded = event?.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
  const parsed: unknown = decoded ? JSON.parse(decoded) : {};
  return isRecord(parsed) ? parsed : {};
}

function normalizePath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}` || "/";
}

function parseGroups(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || current.rules.length || current.crawlDelaySeconds != null) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && current) {
      current.rules.push({ type: key, path: value });
    } else if (key === "crawl-delay" && current) {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }
  return groups;
}

function applicableGroups(text: string, userAgent: string): RobotsGroup[] {
  const groups = parseGroups(text);
  const ua = String(userAgent || "")
    .toLowerCase()
    .split("/")[0];
  const exact = groups.filter((group) =>
    group.agents.some((agent) => agent !== "*" && ua.includes(agent)),
  );
  return exact.length ? exact : groups.filter((group) => group.agents.includes("*"));
}

function matchesRule(path: string, rulePath: string): boolean {
  if (!rulePath) return false;
  const escaped = rulePath
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\\\$$/, "$");
  return new RegExp(`^${escaped}`).test(path);
}

function isPathAllowed(robotsText: string | null, targetUrl: string, userAgent: string): boolean {
  if (robotsText == null) return true;
  const applicable = applicableGroups(robotsText, userAgent);
  const path = normalizePath(targetUrl);
  const rules = applicable
    .flatMap((group) => group.rules)
    .filter((rule) => matchesRule(path, rule.path));
  if (!rules.length) return true;
  rules.sort((a, b) => b.path.length - a.path.length || (a.type === "allow" ? -1 : 1));
  return rules[0].type === "allow";
}

function getCrawlDelayMs(robotsText: string | null, userAgent: string): number {
  if (robotsText == null) return 0;
  const delays = applicableGroups(robotsText, userAgent)
    .map((group) => group.crawlDelaySeconds)
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
  return delays.length ? Math.max(...delays) * 1000 : 0;
}

async function fetchRobotsPolicy(
  fetchFn: RelayFetch,
  baseUrl: string,
  userAgent: string,
): Promise<string | null> {
  const robotsUrl = new URL("/robots.txt", baseUrl).toString();
  const response = await fetchFn(robotsUrl, {
    headers: { "User-Agent": userAgent },
    redirect: "follow",
  });
  if (response.status === 429) throw new Error("robots.txt temporarily unavailable (429)");
  if (response.status >= 400 && response.status < 500) return null;
  if (response.status >= 500)
    throw new Error(`robots.txt temporarily unavailable (${response.status})`);
  if (!response.ok) return null;
  return response.text();
}

function configuredEntryUrl(env: RelayEnv): string {
  const url = new URL(env.AUDIOUNION_ENTRY_URL || DEFAULT_ENTRY_URL);
  if (url.protocol !== "https:" || url.hostname !== AUDIOUNION_HOST) {
    throw new Error("AUDIOUNION_ENTRY_URL must use https://www.audiounion.jp");
  }
  return url.toString();
}

function isAllowedAudioUnionDetailUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === AUDIOUNION_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    /^\/ct\/detail\/used\/\d+\/?$/.test(url.pathname) &&
    url.search === "" &&
    url.hash === ""
  );
}

function isAllowedHifidoUrl(url: URL): boolean {
  if (url.protocol !== "https:" || url.hostname !== HIFIDO_HOST || url.pathname !== "/")
    return false;
  for (const key of url.searchParams.keys()) {
    if (!HIFIDO_ALLOWED_QUERY_KEYS.has(key)) return false;
  }
  if (url.searchParams.get("L") !== "50") return false;
  if (url.searchParams.get("LNG") !== "J") return false;
  if (url.searchParams.get("OD") !== "0") return false;
  const offset = Number.parseInt(url.searchParams.get("O") || "", 10);
  return Number.isSafeInteger(offset) && offset >= 0 && offset % 30 === 0;
}

function isAllowedTarget(requestedUrl: URL, env: RelayEnv): boolean {
  if (requestedUrl.toString() === configuredEntryUrl(env)) return true;
  if (isAllowedAudioUnionDetailUrl(requestedUrl)) return true;
  return isAllowedHifidoUrl(requestedUrl);
}

function safeUserAgent(value: unknown, fallback?: string): string {
  const candidate = String(value || fallback || DEFAULT_USER_AGENT).trim();
  if (!candidate || candidate.length > 300 || /[\r\n]/.test(candidate)) return DEFAULT_USER_AGENT;
  return candidate;
}

function hifidoUserAgent(env: RelayEnv): string {
  return safeUserAgent(env.HIFIDO_USER_AGENT, DEFAULT_HIFIDO_USER_AGENT);
}

function requestProfile(
  requestedUrl: URL,
  requestedUserAgent: string,
  env: RelayEnv,
): RelayRequestProfile {
  if (requestedUrl.hostname !== HIFIDO_HOST) {
    return {
      userAgent: requestedUserAgent,
      headers: {
        "User-Agent": requestedUserAgent,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ja,en;q=0.7",
        "Cache-Control": "no-cache",
      },
    };
  }

  const userAgent = hifidoUserAgent(env);
  return {
    userAgent,
    headers: {
      "User-Agent": userAgent,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Referer: "https://www.hifido.co.jp/",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Upgrade-Insecure-Requests": "1",
    },
  };
}

function nonNegativeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function relayPermitSecret(env: RelayEnv): string | null {
  const secret = String(env.RELAY_PERMIT_SECRET || "");
  return secret.length >= 32 ? secret : null;
}

function signPermit(claims: RelayPermitClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${PERMIT_SIGNING_CONTEXT}${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function parsePermitClaims(value: unknown): RelayPermitClaims | null {
  if (!isRecord(value) || value.version !== RELAY_PERMIT_VERSION) return null;
  const targetUrl = value.targetUrl;
  const requestedUserAgent = value.requestedUserAgent;
  const profileUserAgent = value.profileUserAgent;
  const issuedAtMs = value.issuedAtMs;
  const notBeforeMs = value.notBeforeMs;
  const expiresAtMs = value.expiresAtMs;
  const nonce = value.nonce;
  if (
    typeof targetUrl !== "string" ||
    !targetUrl ||
    typeof requestedUserAgent !== "string" ||
    !requestedUserAgent ||
    typeof profileUserAgent !== "string" ||
    !profileUserAgent ||
    typeof nonce !== "string" ||
    !nonce ||
    !Number.isSafeInteger(issuedAtMs) ||
    !Number.isSafeInteger(notBeforeMs) ||
    !Number.isSafeInteger(expiresAtMs) ||
    (issuedAtMs as number) > (notBeforeMs as number) ||
    (notBeforeMs as number) >= (expiresAtMs as number)
  ) {
    return null;
  }
  return {
    version: RELAY_PERMIT_VERSION,
    targetUrl,
    requestedUserAgent,
    profileUserAgent,
    issuedAtMs: issuedAtMs as number,
    notBeforeMs: notBeforeMs as number,
    expiresAtMs: expiresAtMs as number,
    nonce,
  };
}

function verifyPermit(value: unknown, secret: string): RelayPermitClaims | null {
  if (typeof value !== "string" || !value || value.length > MAX_PERMIT_LENGTH) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, suppliedSignature] = parts;
  const expectedSignature = createHmac("sha256", secret)
    .update(`${PERMIT_SIGNING_CONTEXT}${payload}`)
    .digest("base64url");
  if (!secureEqual(suppliedSignature, expectedSignature)) return null;
  try {
    return parsePermitClaims(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

async function proxyTarget(
  fetchFn: RelayFetch,
  targetUrl: string,
  profile: RelayRequestProfile,
  env: RelayEnv,
): Promise<RelayResponse> {
  const upstream = await fetchFn(targetUrl, {
    headers: profile.headers,
    redirect: "follow",
  });
  const bytes = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers.get("content-type") || "text/html; charset=utf-8";
  return {
    statusCode: upstream.status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-hifiscout-upstream-status": String(upstream.status),
      "x-hifiscout-aws-region": env.AWS_REGION || "unknown",
    },
    body: bytes.toString("base64"),
    isBase64Encoded: true,
  };
}

export function createHandler({
  fetchFn = fetch,
  sleepFn = sleep,
  env = process.env,
  nowFn = Date.now,
  nonceFn = randomUUID,
}: CreateHandlerOptions = {}): RelayHandler {
  return async function handler(event: RelayEvent = {}): Promise<RelayResponse> {
    try {
      const method = event?.requestContext?.http?.method || "POST";
      if (method !== "POST")
        return jsonResponse(405, { error: "method_not_allowed" }, { allow: "POST" });

      const relayToken = String(env.RELAY_TOKEN || "");
      if (relayToken.length < 32) return jsonResponse(500, { error: "relay_token_not_configured" });
      const authorization = requestHeader(event, "authorization");
      const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!secureEqual(suppliedToken, relayToken))
        return jsonResponse(401, { error: "unauthorized" });

      let body: RelayRequestBody;
      try {
        body = decodeRequestBody(event);
      } catch {
        return jsonResponse(400, { error: "invalid_json" });
      }

      const operation = body.operation === "prepare" || body.operation === "fetch" ? body.operation : "legacy";
      if (operation === "fetch") {
        const secret = relayPermitSecret(env);
        if (!secret) return jsonResponse(500, { error: "relay_permit_secret_not_configured" });
        const claims = verifyPermit(body.permit, secret);
        if (!claims) return jsonResponse(401, { error: "invalid_permit" });

        const nowMs = nowFn();
        if (nowMs < claims.notBeforeMs) {
          return jsonResponse(425, {
            error: "permit_not_ready",
            notBeforeMs: claims.notBeforeMs,
          });
        }
        if (nowMs >= claims.expiresAtMs) {
          return jsonResponse(410, { error: "permit_expired" });
        }

        let requestedUrl: URL;
        try {
          requestedUrl = new URL(String(body.url || ""));
        } catch {
          return jsonResponse(409, { error: "permit_binding_mismatch" });
        }
        const requestedUserAgent = safeUserAgent(body.userAgent, env.CRAWLER_USER_AGENT);
        if (
          requestedUrl.toString() !== claims.targetUrl ||
          requestedUserAgent !== claims.requestedUserAgent
        ) {
          return jsonResponse(409, { error: "permit_binding_mismatch" });
        }
        if (!isAllowedTarget(requestedUrl, env)) {
          return jsonResponse(409, { error: "permit_target_no_longer_allowed" });
        }

        const profile = requestProfile(requestedUrl, requestedUserAgent, env);
        if (profile.userAgent !== claims.profileUserAgent) {
          return jsonResponse(409, { error: "permit_profile_changed" });
        }
        return proxyTarget(fetchFn, claims.targetUrl, profile, env);
      }

      let requestedUrl: URL;
      try {
        requestedUrl = new URL(String(body.url || ""));
      } catch {
        return jsonResponse(400, { error: "invalid_target_url" });
      }
      if (!isAllowedTarget(requestedUrl, env))
        return jsonResponse(400, { error: "target_not_allowed" });

      const requestedUserAgent = safeUserAgent(body.userAgent, env.CRAWLER_USER_AGENT);
      const profile = requestProfile(requestedUrl, requestedUserAgent, env);
      const minimumDelayMs = nonNegativeNumber(env.MIN_REQUEST_DELAY_MS, DEFAULT_MIN_DELAY_MS);
      const requestedDelayMs = nonNegativeNumber(body.requestDelayMs, 0);
      const targetUrl = requestedUrl.toString();
      const robotsText = await fetchRobotsPolicy(fetchFn, targetUrl, profile.userAgent);
      if (!isPathAllowed(robotsText, targetUrl, profile.userAgent)) {
        return jsonResponse(409, { error: "robots_disallowed" });
      }

      const effectiveDelayMs = Math.max(
        minimumDelayMs,
        requestedDelayMs,
        getCrawlDelayMs(robotsText, profile.userAgent),
      );

      if (operation === "prepare") {
        const secret = relayPermitSecret(env);
        if (!secret) return jsonResponse(500, { error: "relay_permit_secret_not_configured" });
        const issuedAtMs = nowFn();
        const notBeforeMs = issuedAtMs + effectiveDelayMs;
        const expiresAtMs = notBeforeMs + RELAY_PERMIT_TTL_MS;
        const claims: RelayPermitClaims = {
          version: RELAY_PERMIT_VERSION,
          targetUrl,
          requestedUserAgent,
          profileUserAgent: profile.userAgent,
          issuedAtMs,
          notBeforeMs,
          expiresAtMs,
          nonce: nonceFn(),
        };
        return jsonResponse(200, {
          operation: "prepared",
          permit: signPermit(claims, secret),
          targetUrl,
          requestedUserAgent,
          effectiveUserAgent: profile.userAgent,
          effectiveDelayMs,
          issuedAtMs,
          notBeforeMs,
          expiresAtMs,
          notBefore: new Date(notBeforeMs).toISOString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
        });
      }

      // Compatibility path for the Queue-based relay consumers. Phase 4 adds the permit protocol
      // without changing production pacing semantics; Phase 5 will move these callers to DO Alarms.
      if (effectiveDelayMs > 0) await sleepFn(effectiveDelayMs);
      return proxyTarget(fetchFn, targetUrl, profile, env);
    } catch (error) {
      return jsonResponse(502, {
        error: "relay_failure",
        message: String(error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
  };
}

export const handler = createHandler();