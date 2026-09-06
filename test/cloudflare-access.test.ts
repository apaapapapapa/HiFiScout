import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

import {
  normalizeCloudflareAccessTeamDomain,
  verifyCloudflareAccessToken,
  requireCloudflareAccess,
} from "../src/admin/access.js";

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function encodedJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signedToken(
  privateKey: CryptoKey,
  payload: Record<string, unknown>,
  kid = "test-key",
): Promise<string> {
  const header = encodedJson({ alg: "RS256", typ: "JWT", kid });
  const body = encodedJson(payload);
  const input = new TextEncoder().encode(`${header}.${body}`);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    input as BufferSource,
  );
  return `${header}.${body}.${base64Url(new Uint8Array(signature))}`;
}

async function accessJwk(publicKey: CryptoKey): Promise<JsonWebKey & { kid: string }> {
  return {
    ...(await crypto.subtle.exportKey("jwk", publicKey)),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };
}

test("Cloudflare Access team domain accepts only HTTPS cloudflareaccess.com origins", () => {
  assert.equal(
    normalizeCloudflareAccessTeamDomain("team.cloudflareaccess.com"),
    "https://team.cloudflareaccess.com",
  );
  assert.equal(
    normalizeCloudflareAccessTeamDomain("https://team.cloudflareaccess.com"),
    "https://team.cloudflareaccess.com",
  );
  assert.equal(normalizeCloudflareAccessTeamDomain("https://example.com"), null);
  assert.equal(normalizeCloudflareAccessTeamDomain("http://team.cloudflareaccess.com"), null);
  assert.equal(normalizeCloudflareAccessTeamDomain("https://team.cloudflareaccess.com/path"), null);
  // The provisioning script publishes this value into `$GITHUB_OUTPUT`, where an embedded
  // newline would declare additional workflow outputs.
  assert.equal(
    normalizeCloudflareAccessTeamDomain("team.cloudflareaccess.com\naccess_aud=injected"),
    null,
  );
});

test("Access reuses public keys for concurrent requests but still verifies every signature and expiry", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await accessJwk(pair.publicKey);
  const now = 1_800_000_000;
  const config = { teamDomain: "https://cache.cloudflareaccess.com", audience: "admin" };
  const token = await signedToken(pair.privateKey, {
    iss: config.teamDomain,
    aud: "admin",
    exp: now + 600,
  });
  let loads = 0;
  const fetchFn = (async () => {
    loads += 1;
    return new Response(JSON.stringify({ keys: [jwk] }));
  }) as typeof fetch;
  const imports = vi.spyOn(crypto.subtle, "importKey");
  const verifies = vi.spyOn(crypto.subtle, "verify");
  try {
    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        verifyCloudflareAccessToken(token, config, { fetchFn, nowSeconds: now }),
      ),
    );
    assert.ok(claims.every(Boolean));
    assert.equal(loads, 1);
    assert.equal(imports.mock.calls.length, 1);
    assert.equal(verifies.mock.calls.length, 8);
    assert.equal(
      await verifyCloudflareAccessToken(token, config, { fetchFn, nowSeconds: now + 601 }),
      null,
    );
    const parts = token.split(".");
    assert.equal(
      await verifyCloudflareAccessToken(`${parts[0]}.${parts[1]}.AAAA`, config, {
        fetchFn,
        nowSeconds: now,
      }),
      null,
    );
  } finally {
    imports.mockRestore();
    verifies.mockRestore();
  }
});

test("Access refreshes rotated keys with a cooldown and rejects keys absent from refreshed JWKS", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await accessJwk(pair.publicKey);
  const now = 1_800_000_000;
  const config = { teamDomain: "https://rotation.cloudflareaccess.com", audience: "admin" };
  const claims = { iss: config.teamDomain, aud: "admin", exp: now + 600 };
  const oldToken = await signedToken(pair.privateKey, claims);
  const newToken = await signedToken(pair.privateKey, claims, "rotated");
  let loads = 0;
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({ keys: [++loads === 1 ? jwk : { ...jwk, kid: "rotated" }] }),
    )) as typeof fetch;
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(now * 1000);
    assert.ok(await verifyCloudflareAccessToken(oldToken, config, { fetchFn, nowSeconds: now }));
    assert.equal(
      await verifyCloudflareAccessToken(newToken, config, { fetchFn, nowSeconds: now }),
      null,
    );
    assert.equal(loads, 1);
    vi.setSystemTime(now * 1000 + 30_001);
    assert.ok(await verifyCloudflareAccessToken(newToken, config, { fetchFn, nowSeconds: now }));
    assert.equal(loads, 2);
    assert.equal(
      await verifyCloudflareAccessToken(oldToken, config, { fetchFn, nowSeconds: now }),
      null,
    );
  } finally {
    vi.useRealTimers();
  }
});

test("Access key outages fail closed as retryable 503s and a recovered key service authorizes normally", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await accessJwk(pair.publicKey);
  const config = { teamDomain: "https://outage.cloudflareaccess.com", audience: "admin" };
  const token = await signedToken(pair.privateKey, {
    iss: config.teamDomain,
    aud: "admin",
    exp: Date.now() / 1000 + 600,
  });
  const request = new Request("https://admin.example.test/api/admin/csv-import/apply", {
    headers: { "cf-access-jwt-assertion": token },
  });
  let loads = 0;
  vi.stubGlobal("fetch", async () =>
    ++loads === 1
      ? new Response("unavailable", { status: 503 })
      : new Response(JSON.stringify({ keys: [jwk] })),
  );
  try {
    const denied = await requireCloudflareAccess(request, config);
    assert.equal(denied?.status, 503);
    assert.equal(denied?.headers.get("retry-after"), "1");
    assert.deepEqual(await denied?.json(), { error: "cloudflare_access_unavailable" });
    assert.equal(await requireCloudflareAccess(request, config), null);
    assert.equal((await requireCloudflareAccess(new Request(request.url), config))?.status, 403);
    assert.equal(loads, 2);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("Cloudflare Access JWT verifies signature, issuer, audience and expiry", async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await accessJwk(pair.publicKey);
  const now = 1_800_000_000;
  const issuer = "https://team.cloudflareaccess.com";
  const token = await signedToken(pair.privateKey, {
    iss: issuer,
    aud: ["other", "catalog-admin-aud"],
    exp: now + 600,
    nbf: now - 10,
    email: "member@example.test",
  });
  const fetchFn = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const claims = await verifyCloudflareAccessToken(
    token,
    { teamDomain: issuer, audience: "catalog-admin-aud" },
    { fetchFn, nowSeconds: now },
  );
  assert.equal(claims?.email, "member@example.test");

  assert.equal(
    await verifyCloudflareAccessToken(
      token,
      { teamDomain: issuer, audience: "wrong-audience" },
      { fetchFn, nowSeconds: now },
    ),
    null,
  );
  assert.equal(
    await verifyCloudflareAccessToken(
      token,
      { teamDomain: issuer, audience: "catalog-admin-aud" },
      { fetchFn, nowSeconds: now + 601 },
    ),
    null,
  );
});

test("Cloudflare Access JWT fails closed for tampered signatures", async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await accessJwk(pair.publicKey);
  const now = 1_800_000_000;
  const issuer = "https://team.cloudflareaccess.com";
  const token = await signedToken(pair.privateKey, {
    iss: issuer,
    aud: "catalog-admin-aud",
    exp: now + 600,
  });
  const parts = token.split(".");
  const tampered = `${parts[0]}.${encodedJson({ iss: issuer, aud: "catalog-admin-aud", exp: now + 9999 })}.${parts[2]}`;
  const fetchFn = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as typeof fetch;
  assert.equal(
    await verifyCloudflareAccessToken(
      tampered,
      { teamDomain: issuer, audience: "catalog-admin-aud" },
      { fetchFn, nowSeconds: now },
    ),
    null,
  );
});
