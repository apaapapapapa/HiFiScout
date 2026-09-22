import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test, vi } from "vite-plus/test";
import { getShopEnabled, shopEnvVarName } from "../src/config.js";
import { CrawlScheduler } from "../src/crawler/crawl-scheduler-do.js";
import { CRAWL_SCHEDULER_START_PATH } from "../src/crawler/orchestration.js";
import { getShopPlugin, SHOP_PLUGINS } from "../src/crawler/shops/index.js";

const NOW = Date.parse("2026-09-22T12:00:00+09:00");
const NIGHT = Date.parse("2026-09-22T23:00:00+09:00");
const STORAGE_KEY = "phase2_crawl_execution"; // Public DO record name. gitleaks:allow

afterEach(() => vi.restoreAllMocks());

function forbiddenEnv(vars: Record<string, string> = {}): Env {
  return {
    ...vars,
    DB: { prepare: () => assert.fail("disabled collection must not access D1") },
  } as unknown as Env;
}

function command(shopKey: string, force = true) {
  return {
    schemaVersion: 1,
    type: "start_crawl",
    message: {
      shopKey,
      force,
      requestedAt: new Date(NOW - 60_000).toISOString(),
      jobId: "same-generation",
    },
  };
}

function startRequest(shopKey: string, force = true): Request {
  return new Request(`https://scheduler${CRAWL_SCHEDULER_START_PATH}`, {
    method: "POST",
    body: JSON.stringify(command(shopKey, force)),
  });
}

function memoryScheduler(env: Env, execution?: unknown) {
  const records = new Map<string, unknown>();
  if (execution) records.set(STORAGE_KEY, structuredClone(execution));
  let nextAlarm: number | null = execution ? NOW : null;
  const setAlarm = vi.fn(async (at: number) => {
    nextAlarm = at;
  });
  const deleteAlarm = vi.fn(async () => {
    nextAlarm = null;
  });
  const put = vi.fn(async (key: string, value: unknown) => {
    records.set(key, structuredClone(value));
  });
  const remove = vi.fn(async (key: string) => records.delete(key));
  const ctx = {
    storage: {
      get: async (key: string) => structuredClone(records.get(key)),
      put,
      delete: remove,
      getAlarm: async () => nextAlarm,
      setAlarm,
      deleteAlarm,
    },
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
  } as unknown as DurableObjectState;
  return { scheduler: new CrawlScheduler(ctx, env), records, setAlarm, deleteAlarm, put, remove };
}

test("e-earphone stays excluded in production and in an unconfigured deployment", () => {
  const config = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ) as {
    vars: Record<string, string>;
  };
  const plugin = getShopPlugin("e-earphone");
  assert.ok(plugin, "keep the adapter and historical shop identity registered");
  assert.equal(config.vars.E_EARPHONE_ENABLED, "false");
  assert.equal(getShopEnabled(config.vars, plugin.definition), false);
  assert.equal(getShopEnabled({}, plugin.definition), false);
});

test("disabled shops reject new, forced and replayed DO commands without scheduling or writes", async () => {
  for (const plugin of SHOP_PLUGINS) {
    const env = forbiddenEnv({ [shopEnvVarName(plugin.definition, "ENABLED")]: "false" });
    for (const force of [false, true]) {
      for (const execution of [undefined, { message: command(plugin.key, force).message }]) {
        const h = memoryScheduler(env, execution);
        const before = structuredClone(h.records);
        const response = await h.scheduler.fetch(startRequest(plugin.key, force));
        assert.equal(response.status, 409);
        assert.equal(await response.text(), "shop collection is disabled");
        assert.deepEqual(h.records, before);
        assert.equal(h.setAlarm.mock.calls.length, 0);
        assert.equal(h.put.mock.calls.length, 0);
      }
    }
  }
  const h = memoryScheduler(forbiddenEnv());
  assert.equal((await h.scheduler.fetch(startRequest("e-earphone"))).status, 409);
});

test("disabled listing, detail and inventory Alarms park exact state without seller or D1 work", async () => {
  const clock = vi.spyOn(Date, "now");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => assert.fail("seller I/O"));
  for (const plugin of SHOP_PLUGINS) {
    const env = forbiddenEnv({ [shopEnvVarName(plugin.definition, "ENABLED")]: "false" });
    for (const now of [NOW, NIGHT]) {
      clock.mockReturnValue(now);
      for (const phase of ["initialize", "prepare", "fetch", "detail", "inventory"]) {
        const execution = {
          message: {
            ...command(plugin.key).message,
            collectionRunId: "same-run",
            ...(phase !== "initialize"
              ? {
                  continuation: {
                    phase: phase === "detail" || phase === "inventory" ? "finalize" : "fetch",
                    sequence: 7,
                    pageKey: `${plugin.baseUrl}/unchanged-page`,
                  },
                }
              : {}),
          },
          acceptedAt: new Date(NOW - 60_000).toISOString(),
          nextOriginNotBeforeMs: NOW - 1,
          inventoryRecheckPending: phase === "inventory",
          ...(phase === "detail" ? { detailTargetUrl: `${plugin.baseUrl}/detail` } : {}),
          ...(phase === "fetch"
            ? { permit: { notBeforeMs: NOW - 1 }, relayPermit: { notBeforeMs: NOW - 1 } }
            : {}),
          collectionProgress: { progress: { pages_fetched: 7, pages_parsed: 7 } },
        };
        const h = memoryScheduler(env, execution);
        await h.scheduler.alarm();
        await h.scheduler.alarm(); // Retried or late delivery must remain harmless.
        assert.deepEqual(h.records.get(STORAGE_KEY), execution);
        assert.equal(h.deleteAlarm.mock.calls.length, 2);
        assert.equal(h.setAlarm.mock.calls.length, 0, "not even an overnight re-arm");
        assert.equal(h.put.mock.calls.length, 0);
        assert.equal(h.remove.mock.calls.length, 0);
      }
    }
  }
  assert.equal(fetch.mock.calls.length, 0);
});

test("admin wake cannot bypass an environment-disabled collector", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => assert.fail("seller I/O"));
  const execution = { message: command("e-earphone").message };
  const h = memoryScheduler(forbiddenEnv({ E_EARPHONE_ENABLED: "false" }), execution);
  const response = await h.scheduler.fetch(
    new Request("https://scheduler/admin/control", {
      method: "POST",
      body: JSON.stringify({ shopKey: "e-earphone", action: "wake" }),
    }),
  );
  assert.equal(response.status, 200);
  await h.scheduler.alarm();
  assert.equal(h.deleteAlarm.mock.calls.length, 1);
  assert.deepEqual(h.records.get(STORAGE_KEY), execution);
  assert.equal(fetch.mock.calls.length, 0);
});

test("enabled shops still accept and idempotently re-arm a command", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
  for (const plugin of SHOP_PLUGINS) {
    const h = memoryScheduler(
      forbiddenEnv({ [shopEnvVarName(plugin.definition, "ENABLED")]: "true" }),
    );
    assert.equal((await h.scheduler.fetch(startRequest(plugin.key))).status, 202);
    const stored = structuredClone(h.records.get(STORAGE_KEY));
    assert.equal((await h.scheduler.fetch(startRequest(plugin.key))).status, 202);
    assert.deepEqual(h.records.get(STORAGE_KEY), stored);
    assert.equal(h.setAlarm.mock.calls.length, 2);
  }
});
