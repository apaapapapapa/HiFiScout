import { allowedPushEndpoint, base64Url, decodeBase64Url } from "./policy.js";
import type { PushAddress } from "./policy.js";

const utf8 = (text: string) => new TextEncoder().encode(text);
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
async function hkdf(
  key: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
) {
  const imported = await crypto.subtle.importKey("raw", key, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      imported,
      length * 8,
    ),
  );
}
export interface VapidKey {
  publicKey: string;
  privateKey: JsonWebKey;
}
export async function generateVapidKey(): Promise<VapidKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return {
    publicKey: base64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

/** RFC 8291 single-record aes128gcm, using the runtime's Web Crypto implementation. */
export async function encryptPush(
  address: PushAddress,
  payload: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const plain = utf8(payload);
  if (plain.length > 3000) throw new Error("push_payload_too_large");
  const ua = decodeBase64Url(address.keys.p256dh);
  const recipient = await crypto.subtle.importKey(
    "raw",
    ua,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const sender = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: recipient }, pair.privateKey, 256),
  );
  const ikm = await hkdf(
    shared,
    decodeBase64Url(address.keys.auth),
    concat(utf8("WebPush: info\0"), ua, sender),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, utf8("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      concat(plain, new Uint8Array([2])),
    ),
  );
  // salt(16), record size uint32(4096), key length(65), sender key, encrypted record.
  return concat(salt, new Uint8Array([0, 0, 16, 0, 65]), sender, encrypted);
}
export async function vapidAuthorization(
  keys: VapidKey,
  endpoint: string,
  now: number,
): Promise<string> {
  const input = `${base64Url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })))}.${base64Url(utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 3600, sub: "https://hifiscout.tokyojp.workers.dev/" })))}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    keys.privateKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(input));
  return `vapid t=${input}.${base64Url(signature)}, k=${keys.publicKey}`;
}
export async function sendPush(
  address: PushAddress,
  keys: VapidKey,
  payload: string,
  topic: string,
  now: number,
): Promise<"sent" | "expired" | "retry" | "rejected" | { retryAt: number }> {
  if (!allowedPushEndpoint(address.endpoint)) return "rejected";
  const body = await encryptPush(address, payload);
  const authorization = await vapidAuthorization(keys, address.endpoint, now);
  try {
    const response = await fetch(address.endpoint, {
      method: "POST",
      body,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "900",
        Urgency: "normal",
        Topic: topic.slice(0, 32),
      },
    });
    await response.body?.cancel();
    if (response.ok) return "sent";
    if (response.status === 404 || response.status === 410) return "expired";
    if (response.status === 429 || response.status >= 500) {
      const after = response.headers.get("retry-after");
      const retryAt =
        after && /^\d+$/.test(after) ? now + Number(after) * 1000 : Date.parse(after ?? "");
      return Number.isFinite(retryAt) ? { retryAt: Math.max(now + 300_000, retryAt) } : "retry";
    }
    return "rejected";
  } catch {
    return "retry";
  }
}
