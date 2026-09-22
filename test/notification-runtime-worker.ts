import { DurableObject } from "cloudflare:workers";
import { NotificationStore } from "../src/notifications/storage.js";
import { runNotifications } from "../src/notifications/engine.js";
import { NOTIFICATION_LIMITS as L } from "../src/notifications/policy.js";
import { generateVapidKey } from "../src/notifications/web-push.js";
import type { QueryableDatabase } from "../src/db/types.js";
export { NotificationHub } from "../src/notifications/durable-object.js";

interface FixtureEnv {
  TEST: DurableObjectNamespace;
  REAL: DurableObjectNamespace;
}
interface Input {
  op: string;
  now: number;
  device?: string;
  id?: string;
  result?: "sent" | "retry" | "expired";
  unknown?: boolean;
  queries?: number;
}
export class TestNotifications extends DurableObject<FixtureEnv> {
  async fetch(request: Request) {
    const input = (await request.json()) as Input,
      now = input.now,
      device = input.device ?? "one",
      id = input.id ?? "watch";
    const store = new NotificationStore(this.ctx.storage);
    const observed = Date.parse("2099-09-22T10:00:00.000Z");
    Object.assign(store.usage, { rowsRead: 0, rowsWritten: 0, statements: 0 });
    const keys = store.keys() ?? (await generateVapidKey());
    store.put("vapid", keys);
    let calls = 0;
    const database = {
      prepare(sql: string) {
        const statement = {
          bind: (..._values: unknown[]) => statement,
          async all() {
            calls++;
            return {
              results: sql.includes("last_changed_at AS at")
                ? [{ id: 1, at: new Date(observed - 180_000).toISOString() }]
                : [
                    {
                      id: 1,
                      product_key: "l-1",
                      manufacturer: "LUXMAN",
                      model: "C10",
                      first_seen_at: new Date(observed - 600_000).toISOString(),
                      price_yen: 100000,
                      previous_price_yen: 120000,
                      price_observed_at: new Date(observed - 300_000).toISOString(),
                    },
                  ],
              meta: input.unknown ? {} : { rows_read: 10, rows_written: 0 },
            };
          },
        };
        return statement;
      },
      batch: async () => [],
    } as unknown as QueryableDatabase;
    const pushes: unknown[] = [];
    let next: number | null = null;
    if (input.op === "register") {
      store.register({
        id: device,
        renewedAt: now,
        address: {
          endpoint: `https://web.push.apple.com/Q${device}`,
          keys: { p256dh: "unused", auth: "unused" },
        },
      });
      store.saveWatch(
        device,
        { id, query: "inStock=true", newListings: true, priceDrops: true },
        now - 1_200_000,
      );
    }
    if (input.op === "run")
      next = await runNotifications(
        store,
        database,
        keys,
        now,
        async (_address, _keys, payload) => {
          pushes.push(JSON.parse(payload));
          return input.result ?? "sent";
        },
      );
    if (input.op === "budget") {
      const runtime = store.runtime(now);
      runtime.queries = input.queries ?? L.statementsPerDay;
      store.put("runtime", runtime);
    }
    if (input.op === "remove") store.removeWatch(device, id);
    if (input.op === "device-delete") store.removeDevice(device);
    if (input.op === "enqueue") store.enqueue("manual", store.watch(device, id)!, "{}", now);
    if (input.op === "rollback") {
      try {
        this.ctx.storage.transactionSync(() => {
          store.enqueue("rolled-back", store.watch(device, id)!, "{}", now);
          throw new Error("crash");
        });
      } catch {
        /* deliberately interrupt the atomic outbox commit */
      }
    }
    return Response.json({
      usage: { ...store.usage },
      next,
      calls,
      pushes,
      state: store.runtime(now),
      watches: store.watches(),
      devices: store.devices().map((value) => value.id),
      deliveries: store.sql(
        "SELECT id,device,watch,status,attempts FROM notification_deliveries ORDER BY id",
      ),
    });
  }
}
export default {
  fetch(request: Request, env: FixtureEnv) {
    const url = new URL(request.url);
    return url.pathname.startsWith("/real/")
      ? env.REAL.get(env.REAL.idFromName("real")).fetch(
          new Request(new URL(url.pathname.slice(5), "https://real.test"), request),
        )
      : env.TEST.get(env.TEST.idFromName(url.pathname)).fetch(request);
  },
};
