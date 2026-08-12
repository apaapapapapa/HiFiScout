import test from "node:test";
import assert from "node:assert/strict";
import { decodeHtmlResponse } from "../src/crawler/fetch.js";

test("decodes EUC-JP HTML using the declared response charset", async () => {
  const bytes = Uint8Array.from([
    51, 57, 56, 44, 48, 48, 48, 177, 223, 161, 202, 192, 199, 185, 254, 161, 203,
  ]);
  const response = new Response(bytes, {
    headers: { "content-type": "text/html; charset=EUC-JP" },
  });
  assert.equal(await decodeHtmlResponse(response), "398,000円（税込）");
});

test("defaults to UTF-8 when charset is not declared", async () => {
  const response = new Response("中古オーディオ", {
    headers: { "content-type": "text/html" },
  });
  assert.equal(await decodeHtmlResponse(response), "中古オーディオ");
});
