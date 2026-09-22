import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { build } from "vite-plus";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { recordCostSample } from "../scripts/harness/cost.js";
import { base64Url } from "../src/notifications/policy.js";
import type { Runtime } from "../src/notifications/storage.js";
const now = Date.parse("2099-09-22T10:00:00.000Z");
let mf: Miniflare;
interface Result {
  usage: { rowsRead: number; rowsWritten: number; statements: number };
  calls: number;
  next: number | null;
  state: Runtime;
  pushes: { id: string; tag: string }[];
  deliveries: { id: string; status: string; attempts: number }[];
  watches: unknown[];
  devices: string[];
}
const call = async (name: string, input: Record<string, unknown>) => {
  const response = await mf.dispatchFetch(`https://fixture.test/${name}`, {
    method: "POST",
    body: JSON.stringify({ now, ...input }),
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as Result;
};
beforeAll(async () => {
  const bundle = await build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: { entry: "test/notification-runtime-worker.ts", formats: ["es"] },
      rollupOptions: { external: ["cloudflare:workers"] },
    },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!("output" in output)) throw new Error("missing_bundle");
  const chunk = output.output.find((value) => value.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("missing_chunk");
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: chunk.code,
      compatibilityDate: "2026-08-11",
      bindings: { NOTIFICATIONS_ENABLED: "false" },
      durableObjects: {
        TEST: { className: "TestNotifications", useSQLite: true },
        REAL: { className: "NotificationHub", useSQLite: true },
      },
    }),
  );
}, 30_000);
afterAll(async () => {
  await mf?.dispose();
});

it("persists notices and suppresses duplicate scans, without querying when no watches exist", async () => {
  expect((await call("dedup", { op: "run" })).calls).toBe(0);
  await call("dedup", { op: "register" });
  const first = await call("dedup", { op: "run" });
  expect(first.pushes).toHaveLength(2);
  const again = await call("dedup", { op: "run" });
  expect(again.pushes).toHaveLength(0);
  expect(again.deliveries).toHaveLength(2);
  expect(again.state.reads).toBe(40);
  await call("dedup", { op: "remove" });
  const empty = await call("dedup", { op: "run" });
  expect(empty.calls).toBe(0);
  expect(empty.next).toBeNull();
  expect(empty.deliveries).toHaveLength(0);
});
it("resumes an idle hub near the new opt-in without resetting its same-day budget", async () => {
  await call("resume", { op: "register" });
  await call("resume", { op: "budget", queries: 100 });
  await call("resume", { op: "remove" });
  const resumed = await call("resume", { op: "register", now: now + 3_600_000 });
  expect(resumed.state.queries).toBe(100);
  expect(resumed.state.cursor.at).toBe(new Date(now - 1_200_000).toISOString());
  expect(resumed.state.work).toBeNull();
  expect(resumed.state.windowActive).toBe(false);
});
it("replays a durable outbox insert without any data writes and rolls back interrupted inserts", async () => {
  await call("replay", { op: "register" });
  await call("replay", { op: "enqueue" });
  const replay = await call("replay", { op: "enqueue" });
  expect(replay.usage.rowsWritten).toBe(0);
  await recordCostSample(
    "notification-outbox-replay",
    "local-workerd",
    {
      rowsRead: replay.usage.rowsRead,
      rowsWritten: replay.usage.rowsWritten,
      sqlStatements: replay.usage.statements,
    },
    ["test/notification-runtime.test.ts", "test/notification-runtime-worker.ts"],
  );
  expect((await call("replay", { op: "rollback" })).deliveries.map((row) => row.id)).toEqual([
    "manual",
  ]);
});
it("keeps UTC usage and cursor state across failures and refuses unknown measurements", async () => {
  await call("budget", { op: "register" });
  await call("budget", { op: "budget" });
  const capped = await call("budget", { op: "run" });
  expect(capped.calls).toBe(0);
  expect(capped.state.error).toBe("notification_budget_exhausted");
  expect(capped.next).toBe(Date.parse("2099-09-23T00:00:00Z"));
  await call("unknown", { op: "register" });
  const unknown = await call("unknown", { op: "run", unknown: true });
  expect(unknown.calls).toBe(1);
  expect(unknown.state.unknown).toBe(true);
  expect(unknown.state.reads).toBe(5000);
  expect((await call("unknown", { op: "run" })).calls).toBe(0);
});
it("limits transient attempts, drops expired subscriptions and cancels queued delivery on removal", async () => {
  await call("retry", { op: "register" });
  const first = await call("retry", { op: "run", result: "retry" });
  expect(first.pushes).toHaveLength(2);
  await call("retry", { op: "run", result: "retry", now: now + 300_000 });
  const third = await call("retry", { op: "run", result: "retry", now: now + 600_000 });
  expect(third.deliveries.filter((job) => job.status === "failed")).toHaveLength(2);
  await call("retry", { op: "remove" });
  expect((await call("retry", { op: "run", now: now + 900_000 })).pushes).toHaveLength(0);
  await call("expired", { op: "register" });
  const expired = await call("expired", { op: "run", result: "expired" });
  expect(expired.devices).toEqual([]);
  expect(expired.next).toBeNull();
});
it("the real hub validates keys, keeps capabilities private and isolates device deletion", async () => {
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const key = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const address = {
    endpoint: "https://web.push.apple.com/Qtest",
    keys: {
      p256dh: base64Url(await crypto.subtle.exportKey("raw", key.publicKey)),
      auth: base64Url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
  const api = (path: string, method: string, body?: unknown, auth = token) =>
    mf.dispatchFetch(`https://fixture.test/real/${path}`, {
      method,
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect((await api("device", "POST", address)).status).toBe(200);
  expect(
    (
      await api("watches", "POST", {
        id: "one",
        query: "q=LUXMAN",
        newListings: true,
        priceDrops: true,
      })
    ).status,
  ).toBe(200);
  const status = await api("status", "GET");
  const text = await status.text();
  expect(text).not.toContain(address.endpoint);
  expect(text).not.toContain(token);
  const other = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  expect((await api("device", "POST", address, other)).status).toBe(409);
  await api("device", "DELETE", undefined, other);
  expect(
    ((await (await api("status", "GET")).json()) as { watches: unknown[] }).watches,
  ).toHaveLength(1);
  await api("device", "DELETE");
  expect(
    ((await (await api("status", "GET")).json()) as { watches: unknown[] }).watches,
  ).toHaveLength(0);
});
