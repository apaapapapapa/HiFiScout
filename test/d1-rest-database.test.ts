import assert from "node:assert/strict";
import { test } from "vitest";
import { createD1RestDatabase } from "../scripts/lib/d1-rest-database.js";

interface CapturedRequest {
  url: string;
  authorization: string;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

test("D1 REST adapter sends bound queries directly to the database API", async () => {
  const captured: CapturedRequest[] = [];
  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    captured.push({
      url: String(input),
      authorization: headers.get("authorization") || "",
      body: JSON.parse(String(init?.body || "{}")) as unknown,
    });
    return jsonResponse({
      success: true,
      result: [
        {
          success: true,
          results: [{ id: 7, manufacturer: "Accuphase" }],
          meta: { changes: 0 },
        },
      ],
      errors: [],
    });
  };
  const db = createD1RestDatabase({
    accountId: "account-id",
    databaseId: "database-id",
    apiToken: "secret-token",
    fetchImpl: fakeFetch as typeof fetch,
  });

  const result = await db
    .prepare("SELECT id, manufacturer FROM products WHERE id = ? AND is_active = ?")
    .bind(7, true)
    .all<{ id: number; manufacturer: string }>();

  assert.deepEqual(result.results, [{ id: 7, manufacturer: "Accuphase" }]);
  assert.equal(captured.length, 1);
  assert.equal(
    captured[0]?.url,
    "https://api.cloudflare.com/client/v4/accounts/account-id/d1/database/database-id/query",
  );
  assert.equal(captured[0]?.authorization, "Bearer secret-token");
  assert.deepEqual(captured[0]?.body, {
    sql: "SELECT id, manufacturer FROM products WHERE id = 7 AND is_active = 1",
  });
});

test("D1 REST adapter renders NULL and quoted strings without replacing literal question marks", async () => {
  let body: unknown;
  const fakeFetch = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    body = JSON.parse(String(init?.body || "{}")) as unknown;
    return jsonResponse({
      success: true,
      result: [{ success: true, results: [], meta: { changes: 1 } }],
      errors: [],
    });
  };
  const db = createD1RestDatabase({
    accountId: "account",
    databaseId: "database",
    apiToken: "token",
    fetchImpl: fakeFetch as typeof fetch,
  });

  await db
    .prepare("UPDATE example SET value = ?, optional = ? WHERE marker = '?' AND id = ? -- ?")
    .bind("O'Brien", null, 9)
    .run();

  assert.deepEqual(body, {
    sql: "UPDATE example SET value = 'O''Brien', optional = NULL WHERE marker = '?' AND id = 9 -- ?",
  });
});

test("D1 REST adapter preserves D1 batch semantics in one API request", async () => {
  const captured: CapturedRequest[] = [];
  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    captured.push({
      url: String(input),
      authorization: headers.get("authorization") || "",
      body: JSON.parse(String(init?.body || "{}")) as unknown,
    });
    return jsonResponse({
      success: true,
      result: [
        { success: true, results: [], meta: { changes: 1 } },
        { success: true, results: [], meta: { changes: 2 } },
      ],
      errors: [],
    });
  };
  const db = createD1RestDatabase({
    accountId: "account",
    databaseId: "database",
    apiToken: "token",
    fetchImpl: fakeFetch as typeof fetch,
  });

  const results = await db.batch([
    db.prepare("UPDATE products SET model = ? WHERE id = ?").bind("C-3900", 1),
    db.prepare("DELETE FROM product_feature_facts WHERE product_id = ?").bind(1),
  ]);

  assert.equal(results[0]?.meta?.changes, 1);
  assert.equal(results[1]?.meta?.changes, 2);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]?.body, {
    batch: [
      { sql: "UPDATE products SET model = 'C-3900' WHERE id = 1" },
      { sql: "DELETE FROM product_feature_facts WHERE product_id = 1" },
    ],
  });
});

test("D1 REST adapter honors Retry-After on API rate limiting", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fakeFetch = async (): Promise<Response> => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse(
        { success: false, errors: [{ code: 10000, message: "rate limited" }] },
        429,
        { "Retry-After": "2" },
      );
    }
    return jsonResponse({
      success: true,
      result: [{ success: true, results: [{ count: 1 }], meta: { changes: 0 } }],
      errors: [],
    });
  };
  const db = createD1RestDatabase({
    accountId: "account",
    databaseId: "database",
    apiToken: "token",
    fetchImpl: fakeFetch as typeof fetch,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });

  const row = await db.prepare("SELECT 1 AS count").first<{ count: number }>();

  assert.deepEqual(row, { count: 1 });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2000]);
});

test("D1 REST adapter does not leak the API token in errors", async () => {
  const fakeFetch = async (): Promise<Response> =>
    jsonResponse(
      { success: false, errors: [{ code: 7500, message: "database unavailable" }] },
      503,
    );
  const db = createD1RestDatabase({
    accountId: "account",
    databaseId: "database",
    apiToken: "super-secret-token",
    fetchImpl: fakeFetch as typeof fetch,
  });

  await assert.rejects(
    () => db.prepare("SELECT 1").all(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 503/);
      assert.match(error.message, /database unavailable/);
      assert.doesNotMatch(error.message, /super-secret-token/);
      return true;
    },
  );
});
