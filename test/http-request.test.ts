import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { readJsonBody, REQUEST_BODY_TOO_LARGE } from "../src/http/request.js";

function request(body?: BodyInit): Request {
  return new Request("https://example.test/", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
}

test.each([
  [undefined, undefined],
  ["", undefined],
  [" \n\t", undefined],
  ["{", null],
  ["null", null],
  ["false", false],
  ['{"value":"日本語"}', { value: "日本語" }],
] as const)("JSON body preserves empty, malformed and valid input: %j", async (body, expected) => {
  assert.deepEqual(await readJsonBody(request(body)), expected);
});

test("streamed JSON preserves UTF-8 across byte boundaries and accepts exactly the byte limit", async () => {
  const value = { title: "日本語 🎵" };
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  assert.deepEqual(await readJsonBody(request(body), bytes.length), value);
});

test("streamed JSON cancels at the byte limit even when the character count fits", async () => {
  const bytes = new TextEncoder().encode('"日"');
  let cancelled: unknown;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 3));
      controller.enqueue(bytes.subarray(3));
    },
    cancel(reason) {
      cancelled = reason;
    },
  });
  assert.equal(await readJsonBody(request(body), bytes.length - 1), REQUEST_BODY_TOO_LARGE);
  assert.equal(cancelled, "request_body_too_large");
});
