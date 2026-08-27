import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { PRODUCT_CORRECTION_REPORT_MAX_BODY_BYTES } from "../src/api/product-correction-report-contract.js";
import { handleProductCorrectionReport } from "../src/http/product-correction-report.js";

const unusedEnv = { DB: null as never };
const URL = "https://example.test/api/product-correction-reports";

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: string };
  return body.error;
}

test("correction report endpoint requires JSON", async () => {
  const response = await handleProductCorrectionReport(
    new Request(URL, {
      method: "POST",
      headers: { origin: "https://example.test" },
      body: "{}",
    }),
    unusedEnv,
  );
  assert.equal(response.status, 415);
  assert.equal(await errorCode(response), "application_json_required");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("correction report endpoint rejects cross-origin browser writes", async () => {
  const response = await handleProductCorrectionReport(
    new Request(URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ productKey: "c-1", reason: "wrong_model" }),
    }),
    unusedEnv,
  );
  assert.equal(response.status, 403);
  assert.equal(await errorCode(response), "same_origin_required");
});

test("correction report endpoint rejects oversized bodies before database access", async () => {
  const response = await handleProductCorrectionReport(
    new Request(URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://example.test",
        "content-length": String(PRODUCT_CORRECTION_REPORT_MAX_BODY_BYTES + 1),
      },
      body: "{}",
    }),
    unusedEnv,
  );
  assert.equal(response.status, 413);
  assert.equal(await errorCode(response), "request_body_too_large");
});

test("correction report endpoint rejects malformed and hostile payloads", async () => {
  const malformed = await handleProductCorrectionReport(
    new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.test" },
      body: "{",
    }),
    unusedEnv,
  );
  assert.equal(malformed.status, 400);
  assert.equal(await errorCode(malformed), "invalid_json");

  const hostile = await handleProductCorrectionReport(
    new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.test" },
      body: JSON.stringify({
        productKey: "c-1",
        reason: "other_factual_error",
        explanation: "<img src=x onerror=alert(1)>",
      }),
    }),
    unusedEnv,
  );
  assert.equal(hostile.status, 400);
  assert.equal(await errorCode(hostile), "invalid_correction_report");
});
