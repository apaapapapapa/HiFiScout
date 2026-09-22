import { DurableObject } from "cloudflare:workers";
import { readJsonBody } from "../http/request.js";
import {
  decodeBase64Url,
  digest,
  NOTIFICATION_LIMITS as L,
  parsePushAddress,
  parseWatch,
} from "./policy.js";
import { NotificationStore } from "./storage.js";
import { runNotifications } from "./engine.js";
import { generateVapidKey } from "./web-push.js";
import type { VapidKey } from "./web-push.js";

const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** One independent scheduler. No public endpoint can request a scan, send or arbitrary URL fetch. */
export class NotificationHub extends DurableObject<Env> {
  private store!: NotificationStore;
  private keys!: VapidKey;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.store = new NotificationStore(ctx.storage);
      this.keys = this.store.keys() ?? (await generateVapidKey());
      this.store.put("vapid", this.keys);
    });
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/config" && request.method === "GET")
      return reply({ publicKey: this.keys.publicKey, maxWatches: L.watchesPerDevice });
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) return reply({ error: "notification_unauthorized" }, 401);
    const deviceId = await digest(token);
    const now = Date.now();
    const existing = this.store.device(deviceId);
    if (existing && existing.renewedAt < now - L.deviceExpiryMs) this.store.removeDevice(deviceId);
    if (path === "/device" && request.method === "POST") {
      const address = parsePushAddress(await readJsonBody(request, 4096));
      if (!address) return reply({ error: "invalid_push_subscription" }, 400);
      // Invalid curve points are rejected before storing a permanently undeliverable address.
      try {
        await crypto.subtle.importKey(
          "raw",
          decodeBase64Url(address.keys.p256dh),
          { name: "ECDH", namedCurve: "P-256" },
          false,
          [],
        );
      } catch {
        return reply({ error: "invalid_push_key" }, 400);
      }
      this.store.prune(now);
      if (!this.store.register({ id: deviceId, address, renewedAt: now }))
        return reply({ error: "notification_capacity_or_subscription_conflict" }, 409);
      return reply({ ok: true });
    }
    const device = this.store.device(deviceId);
    if (path === "/status" && request.method === "GET") {
      const state = this.store.runtime(now);
      const watches = device
        ? this.store.watches(deviceId).map(({ device: _device, ...watch }) => watch)
        : [];
      const failed = device
        ? Number(
            this.store.sql<{ total: number }>(
              "SELECT count(*) AS total FROM notification_deliveries WHERE device=? AND status='failed'",
              deviceId,
            )[0].total,
          )
        : 0;
      return reply({
        registered: Boolean(device),
        watches,
        lastCheck: state.lastCheck,
        delayed: Boolean(
          state.error ||
          state.work ||
          state.pushes >= L.pushesPerDay ||
          (state.lastCheck && now - state.lastCheck > L.intervalMs * 2),
        ),
        failed,
      });
    }
    if (path === "/device" && request.method === "DELETE") {
      this.store.removeDevice(deviceId);
      if (!this.store.watches().length) await this.ctx.storage.deleteAlarm();
      return reply({ ok: true });
    }
    if (path === "/watches" && request.method === "POST") {
      if (!device) return reply({ error: "notification_registration_expired" }, 401);
      const watch = parseWatch(await readJsonBody(request, 4096));
      if (!watch) return reply({ error: "invalid_notification_watch" }, 400);
      if (!this.store.saveWatch(deviceId, watch, now))
        return reply({ error: "notification_watch_limit" }, 409);
      // Registration recovers a missing alarm, without resetting budgets or triggering seller I/O.
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(now + L.continuationMs);
      return reply({ ok: true });
    }
    if (path.startsWith("/watches/") && request.method === "DELETE") {
      const id = path.slice("/watches/".length);
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(id))
        return reply({ error: "invalid_notification_watch" }, 400);
      this.store.storage.transactionSync(() => this.store.removeWatch(deviceId, id));
      if (!this.store.watches().length) await this.ctx.storage.deleteAlarm();
      return reply({ ok: true });
    }
    return reply({ error: "not_found" }, 404);
  }
  async alarm(): Promise<void> {
    if (this.env.NOTIFICATIONS_ENABLED !== "true") return;
    // Keep subscription mutation and sends ordered. Passes stop starting work after 20 seconds;
    // subsequent alarms resume the persisted query cursor and pre-recorded delivery attempts.
    await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      // Pre-arm so termination during work does not lose the wake-up; duplicate work is idempotent.
      await this.ctx.storage.setAlarm(now + L.intervalMs);
      const next = await runNotifications(this.store, this.env.DB, this.keys, now);
      if (next === null) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(next);
    });
  }
}
