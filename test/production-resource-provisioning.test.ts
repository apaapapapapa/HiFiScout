import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  provisionProductionResources,
  reconcileLifecycleRules,
  requiredLifecycleRules,
  requiredQueues,
  ResourceApiError,
} from "../scripts/lib/production-resources.js";
import type { ResourceApi } from "../scripts/lib/production-resources.js";

test("unchanged production resources use three reads and perform zero writes", async () => {
  const calls: string[] = [];
  const api: ResourceApi = async (path, method = "GET") => {
    calls.push(`${method} ${path}`);
    assert.equal(method, "GET");
    if (path.endsWith("/lifecycle"))
      return { result: { rules: structuredClone(requiredLifecycleRules) } };
    if (path.startsWith("/queues?"))
      return { result: requiredQueues.map((queue_name) => ({ queue_name })) };
    return { result: {} };
  };
  await provisionProductionResources(api);
  assert.equal(calls.length, 3);
});

test("lifecycle drift is corrected atomically while unrelated rules survive", () => {
  const operatorRule = { id: "operator-owned", enabled: true, conditions: { prefix: "custom/" } };
  const existing = [operatorRule, { ...requiredLifecycleRules[0], enabled: false }];
  const merged = reconcileLifecycleRules(existing);
  assert.ok(merged);
  assert.deepEqual(merged[0], operatorRule);
  assert.equal(merged.length, requiredLifecycleRules.length + 1);
  assert.equal(reconcileLifecycleRules(merged), null);
  assert.equal(existing[1].enabled, false, "planning must not mutate the observed configuration");
});

test("Queue pagination finds existing resources before creating only a missing queue", async () => {
  const created: unknown[] = [];
  const api: ResourceApi = async (path, method = "GET", body) => {
    if (method === "POST") {
      created.push(body);
      return { result: {} };
    }
    if (path.endsWith("/lifecycle")) return { result: { rules: requiredLifecycleRules } };
    if (path.startsWith("/queues?")) {
      const page = new URL(`https://example.test${path}`).searchParams.get("page");
      return {
        result: (page === "1" ? requiredQueues.slice(0, 2) : requiredQueues.slice(2, 3)).map(
          (queue_name) => ({ queue_name }),
        ),
        result_info: { total_pages: 2 },
      };
    }
    return { result: {} };
  };
  await provisionProductionResources(api);
  assert.deepEqual(created, [{ queue_name: requiredQueues[3] }]);
});

test("a forbidden bucket read cannot trigger resource creation", async () => {
  const calls: string[] = [];
  await assert.rejects(
    provisionProductionResources(async (path, method = "GET") => {
      calls.push(`${method} ${path}`);
      throw new ResourceApiError(403, "Forbidden");
    }),
    /Forbidden/,
  );
  assert.equal(calls.length, 1);
});

test("malformed lifecycle responses are never replaced with our policies", async () => {
  await assert.rejects(
    provisionProductionResources(async (_path, method = "GET") => {
      assert.equal(method, "GET");
      return { result: {} };
    }),
    /invalid R2 lifecycle/,
  );
});
