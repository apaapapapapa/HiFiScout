import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCloudflareAccessTeamDomain,
  verifyCloudflareAccessToken,
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
