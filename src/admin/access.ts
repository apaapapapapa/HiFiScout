import { json } from "./http.js";

interface CloudflareAccessConfig {
  teamDomain: string;
  audience: string;
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
}

interface AccessJsonWebKey extends JsonWebKey {
  kid?: string;
}

export interface CloudflareAccessClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  email?: string;
  sub?: string;
  [key: string]: unknown;
}

interface JwksDocument {
  keys?: AccessJsonWebKey[];
}

const JWKS_CACHE_MS = 5 * 60 * 1000;
const JWKS_REFRESH_MIN_MS = 30_000;
interface JwksCache {
  fetchedAt: number;
  keys: AccessJsonWebKey[];
  imported: Map<string, Promise<CryptoKey>>;
}
// Scope test/custom fetchers separately; only public keys are cached, never authentication decisions.
const jwksCaches = new WeakMap<typeof fetch, Map<string, JwksCache>>();
const jwksLoads = new WeakMap<typeof fetch, Map<string, Promise<JwksCache>>>();

export class CloudflareAccessUnavailableError extends Error {
  constructor() {
    super("cloudflare_access_unavailable");
  }
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function parsePart<T>(value: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
  } catch {
    return null;
  }
}

export function normalizeCloudflareAccessTeamDomain(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !url.hostname.endsWith(".cloudflareaccess.com")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

async function loadJwks(url: string, fetchFn: typeof fetch, kid: string): Promise<JwksCache> {
  const now = Date.now();
  const cache = jwksCaches.get(fetchFn) || new Map<string, JwksCache>();
  jwksCaches.set(fetchFn, cache);
  const cached = cache.get(url);
  if (
    cached &&
    now - cached.fetchedAt < JWKS_CACHE_MS &&
    (cached.keys.some((key) => key?.kid === kid) || now - cached.fetchedAt < JWKS_REFRESH_MIN_MS)
  ) {
    return cached;
  }
  const loads = jwksLoads.get(fetchFn) || new Map<string, Promise<JwksCache>>();
  jwksLoads.set(fetchFn, loads);
  const pending = loads.get(url);
  if (pending) return pending;
  const loading = (async () => {
    try {
      const response = await fetchFn(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new CloudflareAccessUnavailableError();
      const document = (await response.json()) as JwksDocument;
      const keys = Array.isArray(document?.keys) ? document.keys : [];
      if (!keys.length || keys.length > 32) throw new CloudflareAccessUnavailableError();
      const entry: JwksCache = { fetchedAt: Date.now(), keys, imported: new Map() };
      if (cache.size >= 4) cache.clear();
      cache.set(url, entry);
      return entry;
    } catch {
      throw new CloudflareAccessUnavailableError();
    }
  })();
  loads.set(url, loading);
  try {
    return await loading;
  } finally {
    loads.delete(url);
  }
}

function audienceMatches(value: unknown, expected: string): value is string | string[] {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.some((item) => item === expected);
}

function validClaims(
  value: unknown,
  issuer: string,
  audience: string,
  nowSeconds: number,
): value is CloudflareAccessClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Record<string, unknown>;
  if (claims.iss !== issuer || !audienceMatches(claims.aud, audience)) return false;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds)
    return false;
  if (
    claims.nbf !== undefined &&
    (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > nowSeconds)
  ) {
    return false;
  }
  return true;
}

export async function verifyCloudflareAccessToken(
  token: string,
  config: CloudflareAccessConfig,
  options: { fetchFn?: typeof fetch; nowSeconds?: number } = {},
): Promise<CloudflareAccessClaims | null> {
  const issuer = normalizeCloudflareAccessTeamDomain(config.teamDomain);
  const audience = config.audience.trim();
  if (!issuer || !audience) return null;

  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const header = parsePart<JwtHeader>(parts[0]);
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    return null;
  }
  const claims = parsePart<unknown>(parts[1]);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!validClaims(claims, issuer, audience, nowSeconds)) return null;

  // Network/key-service failures are retryable 503s, not an invalid or expired login.
  const keys = await loadJwks(
    `${issuer}/cdn-cgi/access/certs`,
    options.fetchFn || fetch,
    header.kid,
  );
  const jwk = keys.keys.find((candidate) => candidate?.kid === header.kid);
  if (!jwk) return null;
  let imported = keys.imported.get(header.kid);
  if (!imported) {
    imported = crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.imported.set(header.kid, imported);
  }
  let key: CryptoKey;
  try {
    key = await imported;
  } catch {
    throw new CloudflareAccessUnavailableError();
  }

  try {
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = decodeBase64Url(parts[2]);
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature as BufferSource,
      signingInput as BufferSource,
    );
    if (!verified) return null;

    return validClaims(
      claims,
      issuer,
      audience,
      options.nowSeconds ?? Math.floor(Date.now() / 1000),
    )
      ? claims
      : null;
  } catch {
    return null;
  }
}

export async function verifyCloudflareAccessRequest(
  request: Request,
  config: CloudflareAccessConfig,
): Promise<CloudflareAccessClaims | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  return token ? verifyCloudflareAccessToken(token, config) : null;
}

/** Both admin entry points fail closed, but allow callers to retry a key-service outage. */
export async function requireCloudflareAccess(
  request: Request,
  config: CloudflareAccessConfig,
): Promise<Response | null> {
  try {
    return (await verifyCloudflareAccessRequest(request, config))
      ? null
      : json({ error: "cloudflare_access_required" }, { status: 403 });
  } catch (error) {
    if (!(error instanceof CloudflareAccessUnavailableError)) throw error;
    console.warn(JSON.stringify({ event: "admin_access_key_service_unavailable" }));
    return json(
      { error: "cloudflare_access_unavailable" },
      { status: 503, headers: { "retry-after": "1" } },
    );
  }
}
