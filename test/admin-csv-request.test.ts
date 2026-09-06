import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { adminCsvRequest } from "../frontend/admin-csv-request.js";
import { AdminOperationError } from "../frontend/admin-shared.js";

test("CSV transient retries are bounded and preserve the exact apply body", async () => {
  vi.useFakeTimers();
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    bodies.push(init.body);
    return new Response(JSON.stringify({ error: "csv_import_unavailable" }), { status: 503 });
  });
  try {
    const body = JSON.stringify({ operationId: "durable-operation" });
    const done = assert.rejects(
      adminCsvRequest("apply", { method: "POST", body }, () => {}),
      AdminOperationError,
    );
    await vi.runAllTimersAsync();
    await done;
    assert.deepEqual(bodies, [body, body, body]);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

test("CSV authentication and conflict failures are not automatically retried", async () => {
  for (const status of [403, 409]) {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ error: status === 403 ? "cloudflare_access_required" : "conflict" }),
        { status },
      );
    });
    try {
      await assert.rejects(
        adminCsvRequest("apply", { method: "POST" }, () => assert.fail("must not retry")),
        AdminOperationError,
      );
      assert.equal(calls, 1);
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

test("CSV cancellation interrupts retry backoff without sending another mutation", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const controller = new AbortController();
  vi.stubGlobal("fetch", async () => {
    calls += 1;
    throw new TypeError("network failure");
  });
  try {
    const done = assert.rejects(
      adminCsvRequest("apply", { signal: controller.signal }, () => {}),
      { name: "AbortError" },
    );
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await done;
    await vi.runAllTimersAsync();
    assert.equal(calls, 1);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
