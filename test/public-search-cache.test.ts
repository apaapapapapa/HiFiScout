import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { handlePublicContractRoute } from "../src/http/public-routes.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { recordingDatabase } from "./helpers/query-plan.js";

test("search routes share canonical cache entries and keep distinct queries apart", async () => {
  const { db } = migratedSqlite();
  const recording = recordingDatabase(db);
  const stored = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        async match(request: Request) {
          return stored.get(request.url)?.clone();
        },
        async put(request: Request, response: Response) {
          stored.set(request.url, response);
        },
      },
    },
  });
  const ctx = {
    waitUntil(work: Promise<unknown>) {
      pending.push(work);
    },
  } as ExecutionContext;
  const request = async (query: string) => {
    const response = await handlePublicContractRoute(
      new Request(`https://example.test/api/product-search?${query}`),
      { DB: recording.db } as unknown as Env,
      ctx,
    );
    await Promise.all(pending);
    assert.ok(response);
    return response;
  };
  try {
    const first = await request("shop=audioshop&limit=50");
    assert.equal(first.status, 200);
    const calls = recording.executed.length;
    assert.ok(calls > 0);
    const equivalent = await request("limit=050&shop=audioshop");
    assert.deepEqual(await equivalent.json(), await first.json());
    assert.equal(recording.executed.length, calls, "equivalent URLs must not query D1 twice");
    await request("limit=50&shop=hifido");
    assert.ok(recording.executed.length > calls, "different filters need different entries");
    const entries = stored.size;
    assert.equal((await request("limit=garbage")).status, 400);
    assert.equal(stored.size, entries, "invalid requests are never cached");
  } finally {
    if (original) Object.defineProperty(globalThis, "caches", original);
    else Reflect.deleteProperty(globalThis, "caches");
  }
});
