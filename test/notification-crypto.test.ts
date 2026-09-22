import { expect, it, vi } from "vite-plus/test";
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { base64Url, decodeBase64Url } from "../src/notifications/policy.js";
import {
  encryptPush,
  generateVapidKey,
  sendPush,
  vapidAuthorization,
} from "../src/notifications/web-push.js";

it("decrypts the RFC 8291 record with an independent Node crypto recipient", async () => {
  const recipient = createECDH("prime256v1");
  recipient.generateKeys();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const payload = JSON.stringify({ title: "HiFiScout 新着", body: "LUXMAN / 100,000円" });
  const body = Buffer.from(
    await encryptPush(
      {
        endpoint: "https://web.push.apple.com/Qtest",
        keys: { p256dh: base64Url(recipient.getPublicKey()), auth: base64Url(auth) },
      },
      payload,
    ),
  );
  expect(body.readUInt32BE(16)).toBe(4096);
  expect(body[20]).toBe(65);
  const publicKey = body.subarray(21, 86),
    salt = body.subarray(0, 16);
  const ikm = hkdfSync(
    "sha256",
    recipient.computeSecret(publicKey),
    auth,
    Buffer.concat([Buffer.from("WebPush: info\0"), recipient.getPublicKey(), publicKey]),
    32,
  );
  const cek = hkdfSync("sha256", Buffer.from(ikm), salt, "Content-Encoding: aes128gcm\0", 16);
  const nonce = hkdfSync("sha256", Buffer.from(ikm), salt, "Content-Encoding: nonce\0", 12);
  const decoder = createDecipheriv("aes-128-gcm", Buffer.from(cek), Buffer.from(nonce));
  decoder.setAuthTag(body.subarray(-16));
  const plain = Buffer.concat([decoder.update(body.subarray(86, -16)), decoder.final()]);
  expect(plain.at(-1)).toBe(2);
  expect(plain.subarray(0, -1).toString()).toBe(payload);
});
it("honors provider retry delays and refuses redirected delivery", async () => {
  const recipient = createECDH("prime256v1");
  recipient.generateKeys();
  const address = {
    endpoint: "https://web.push.apple.com/Qtest",
    keys: {
      p256dh: base64Url(recipient.getPublicKey()),
      auth: base64Url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
  const transport = vi.fn(
    async () => new Response(null, { status: 429, headers: { "retry-after": "3600" } }),
  );
  vi.stubGlobal("fetch", transport);
  try {
    expect(await sendPush(address, await generateVapidKey(), "{}", "topic", 1000)).toEqual({
      retryAt: 3_601_000,
    });
    expect(transport.mock.calls[0]).toEqual([
      address.endpoint,
      expect.objectContaining({ redirect: "error" }),
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("signs a one-hour VAPID JWT for the push provider origin", async () => {
  const pair = await generateVapidKey(),
    now = Date.parse("2026-09-22T10:00:00Z");
  const header = await vapidAuthorization(pair, "https://web.push.apple.com/Qtest", now);
  const jwt = header.match(/^vapid t=(.+), k=/)![1];
  const [a, b, signature] = jwt.split(".");
  expect(JSON.parse(Buffer.from(decodeBase64Url(b)).toString())).toEqual({
    aud: "https://web.push.apple.com",
    exp: now / 1000 + 3600,
    sub: "https://hifiscout.tokyojp.workers.dev/",
  });
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase64Url(pair.publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  expect(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decodeBase64Url(signature),
      new TextEncoder().encode(`${a}.${b}`),
    ),
  ).toBe(true);
});
