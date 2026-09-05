import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
// Execute the actual workflow filters, rather than a second implementation of correlation.
const filters = [...workflow.matchAll(/'(include "cloudflare-ray";[^']+)'/gu)].map(
  (match) => match[1],
);
const quotaMessage = "D1_ERROR: Your account has exceeded D1's free tier daily row read limit.";
const rayId = "a3617637b9bced69";

function tailEvent(ray: unknown, message = quotaMessage) {
  return {
    event: { request: { headers: { "cf-ray": ray } } },
    exceptions: [{ message }],
  };
}

function runFilter(filter: string, ray: string, input: string) {
  const result = spawnSync(
    "jq",
    ["-L", "scripts/lib", "-se", "--arg", "ray", ray, "--arg", "quota", quotaMessage, filter],
    { input, encoding: "utf8", timeout: 5000 },
  );
  assert.ifError(result.error);
  return result;
}

function correlate(ray: string, events: unknown[]) {
  assert.equal(filters.length, 2, "both deployment filters must use the shared correlation helper");
  const [countFilter, quotaFilter] = filters;
  assert.ok(countFilter);
  assert.ok(quotaFilter);
  const input = events.map((event) => JSON.stringify(event)).join("\n");
  const countResult = runFilter(countFilter, ray, input);
  assert.equal(countResult.status, 0, countResult.stderr);
  const quotaResult = runFilter(quotaFilter, ray, input);
  assert.ok(quotaResult.status === 0 || quotaResult.status === 1, quotaResult.stderr);
  return {
    matches: JSON.parse(countResult.stdout) as unknown,
    quota: JSON.parse(quotaResult.stdout) as unknown,
  };
}

for (const [responseRay, requestRay] of [
  [`${rayId}-IAD`, rayId],
  [rayId, `${rayId}-IAD`],
  [`${rayId}-IAD`, `${rayId}-SJC`],
  [rayId, rayId],
  [`${rayId.toUpperCase()}-IAD`, rayId],
]) {
  test(`deployment correlates response ${responseRay} with tail ${requestRay}`, () => {
    assert.ok(responseRay);
    assert.deepEqual(correlate(responseRay, [tailEvent(requestRay)]), { matches: 1, quota: true });
  });
}

test("a matching non-quota error cannot be hidden by another request's quota error", () => {
  assert.deepEqual(
    correlate(`${rayId}-IAD`, [
      tailEvent(rayId, "TypeError: unexpected undefined value"),
      tailEvent("a3617637b9bced60", quotaMessage),
    ]),
    { matches: 1, quota: false },
  );
});

test("unrelated and prefix-only IDs do not establish quota correlation", () => {
  for (const requestRay of ["a3617637b9bced60", rayId.slice(0, -1), `${rayId}0`]) {
    assert.deepEqual(correlate(`${rayId}-IAD`, [tailEvent(requestRay)]), {
      matches: 0,
      quota: false,
    });
  }
});

test("missing and malformed tail IDs cannot match a valid response", () => {
  for (const requestRay of [undefined, null, "", "not-a-ray", `${rayId}-IAD-extra`, 0, {}, []]) {
    assert.deepEqual(correlate(`${rayId}-IAD`, [tailEvent(requestRay)]), {
      matches: 0,
      quota: false,
    });
  }
});

test("two missing or malformed IDs cannot create false correlation", () => {
  for (const invalid of ["", "not-a-ray", "-IAD", `${rayId}-IAD-extra`, `${rayId} `]) {
    assert.deepEqual(correlate(invalid, [tailEvent(invalid)]), { matches: 0, quota: false });
  }
});

test("an empty tail is distinguishable from a matching quota exception", () => {
  assert.deepEqual(correlate(`${rayId}-IAD`, []), { matches: 0, quota: false });
});

test("malformed tail JSON remains an error rather than an empty successful result", () => {
  assert.equal(filters.length, 2);
  for (const filter of filters) {
    assert.ok(filter);
    const result = runFilter(filter, `${rayId}-IAD`, "not JSON");
    assert.ok(result.status !== null && result.status > 1);
  }
});
