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
let cachedJwks: { url: string; expiresAt: number; keys: AccessJsonWebKey[] } | null = null;

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

async function loadJwks(url: string, fetchFn: typeof fetch): Promise<AccessJsonWebKey[]> {
  const now = Date.now();
  if (fetchFn === fetch && cachedJwks?.url === url && cachedJwks.expiresAt > now) {
    return cachedJwks.keys;
  }

  const response = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`access_jwks_http_${response.status}`);
  const document = (await response.json()) as JwksDocument;
  const keys = Array.isArray(document.keys) ? document.keys : [];
  if (!keys.length) throw new Error("access_jwks_empty");
  if (fetchFn === fetch) cachedJwks = { url, expiresAt: now + JWKS_CACHE_MS, keys };
  return keys;
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
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return false;
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > nowSeconds)) {
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

  try {
    const fetchFn = options.fetchFn || fetch;
    const keys = await loadJwks(`${issuer}/cdn-cgi/access/certs`, fetchFn);
    const jwk = keys.find((candidate) => candidate.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = decodeBase64Url(parts[2]);
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature as BufferSource,
      signingInput as BufferSource,
    );
    if (!verified) return null;

    const claims = parsePart<unknown>(parts[1]);
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    return validClaims(claims, issuer, audience, nowSeconds) ? claims : null;
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
