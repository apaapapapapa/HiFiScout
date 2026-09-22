import { NOTIFICATION_LIMITS as L } from "./policy.js";
import type { PushAddress, Watch, WatchInput } from "./policy.js";
import type { NotificationCursor } from "../db/notification-candidates.js";
import type { VapidKey } from "./web-push.js";

export interface Device {
  id: string;
  address: PushAddress;
  renewedAt: number;
}
export interface Work {
  candidates: NotificationCursor[];
  queries: string[];
  index: number;
}
export interface Runtime {
  cursor: NotificationCursor;
  until: string;
  windowActive: boolean;
  work: Work | null;
  lastCheck: number | null;
  day: string;
  queries: number;
  reads: number;
  pushes: number;
  unknown: boolean;
  error: string | null;
}
export interface Delivery {
  id: string;
  device: string;
  watch: string;
  payload: string;
  created: number;
  due: number;
  attempts: number;
  status: string;
}

export class NotificationStore {
  readonly usage = { rowsRead: 0, rowsWritten: 0, statements: 0 };
  constructor(readonly storage: DurableObjectStorage) {
    if (
      !this.sql("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_meta'")
        .length
    )
      storage.transactionSync(() => {
        for (const sql of [
          "CREATE TABLE notification_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
          "CREATE TABLE notification_devices(id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, value TEXT NOT NULL, renewed INTEGER NOT NULL)",
          "CREATE INDEX notification_device_age ON notification_devices(renewed)",
          "CREATE TABLE notification_watches(device TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(device,id))",
          "CREATE TABLE notification_deliveries(id TEXT PRIMARY KEY, device TEXT NOT NULL, watch TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending')",
          "CREATE INDEX notification_delivery_due ON notification_deliveries(status,due)",
          "CREATE INDEX notification_delivery_age ON notification_deliveries(created)",
          "CREATE INDEX notification_delivery_owner ON notification_deliveries(device,watch)",
          "CREATE TABLE notification_counts(id INTEGER PRIMARY KEY CHECK(id=1), deliveries INTEGER NOT NULL)",
          "INSERT INTO notification_counts VALUES(1,0)",
          "CREATE TRIGGER notification_delivery_insert AFTER INSERT ON notification_deliveries BEGIN UPDATE notification_counts SET deliveries=deliveries+1 WHERE id=1; END",
          "CREATE TRIGGER notification_delivery_delete AFTER DELETE ON notification_deliveries BEGIN UPDATE notification_counts SET deliveries=deliveries-1 WHERE id=1; END",
        ])
          this.sql(sql);
      });
  }
  sql<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(
    query: string,
    ...values: SqlStorageValue[]
  ): T[] {
    const cursor = this.storage.sql.exec<T>(query, ...values);
    const result = cursor.toArray();
    this.usage.rowsRead += cursor.rowsRead;
    this.usage.rowsWritten += cursor.rowsWritten;
    this.usage.statements++;
    return result;
  }
  get<T>(key: string): T | null {
    const row = this.sql<{ value: string }>(
      "SELECT value FROM notification_meta WHERE key=?",
      key,
    )[0];
    return row ? (JSON.parse(row.value) as T) : null;
  }
  put(key: string, value: unknown): void {
    const json = JSON.stringify(value);
    this.sql(
      "INSERT INTO notification_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value",
      key,
      json,
    );
  }
  runtime(now: number): Runtime {
    const day = new Date(now).toISOString().slice(0, 10);
    const state = this.get<Runtime>("runtime") ?? {
      cursor: { at: new Date(now - L.overlapMs).toISOString(), id: 0 },
      until: new Date(now - 120_000).toISOString(),
      windowActive: false,
      work: null,
      lastCheck: null,
      day,
      queries: 0,
      reads: 0,
      pushes: 0,
      unknown: false,
      error: null,
    };
    if (state.day !== day)
      Object.assign(state, { day, queries: 0, reads: 0, pushes: 0, unknown: false });
    return state;
  }
  devices(): Device[] {
    return this.sql<{ value: string }>("SELECT value FROM notification_devices LIMIT 51").map(
      (row) => JSON.parse(row.value) as Device,
    );
  }
  device(id: string): Device | null {
    const row = this.sql<{ value: string }>(
      "SELECT value FROM notification_devices WHERE id=?",
      id,
    )[0];
    return row ? (JSON.parse(row.value) as Device) : null;
  }
  register(device: Device): boolean {
    const owner = this.sql<{ id: string }>(
      "SELECT id FROM notification_devices WHERE endpoint=?",
      device.address.endpoint,
    )[0];
    if (owner && owner.id !== device.id) return false;
    if (!this.device(device.id) && this.devices().length >= L.devices) return false;
    this.sql(
      "INSERT INTO notification_devices(id,endpoint,value,renewed) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint,value=excluded.value,renewed=excluded.renewed",
      device.id,
      device.address.endpoint,
      JSON.stringify(device),
      device.renewedAt,
    );
    return true;
  }
  watches(device?: string): Watch[] {
    return this.sql<{ value: string }>(
      device
        ? "SELECT value FROM notification_watches WHERE device=? ORDER BY id LIMIT 6"
        : "SELECT value FROM notification_watches ORDER BY device,id LIMIT 101",
      ...(device ? [device] : []),
    ).map((row) => JSON.parse(row.value) as Watch);
  }
  watch(device: string, id: string): Watch | null {
    const row = this.sql<{ value: string }>(
      "SELECT value FROM notification_watches WHERE device=? AND id=?",
      device,
      id,
    )[0];
    return row ? (JSON.parse(row.value) as Watch) : null;
  }
  saveWatch(device: string, input: WatchInput, now: number): boolean {
    const previous = this.watch(device, input.id);
    if (
      previous &&
      previous.query === input.query &&
      previous.newListings === input.newListings &&
      previous.priceDrops === input.priceDrops
    )
      return true;
    if (
      !previous &&
      (this.watches(device).length >= L.watchesPerDevice || this.watches().length >= L.watches)
    )
      return false;
    const firstWatch = this.watches().length === 0;
    this.storage.transactionSync(() => {
      this.removeWatch(device, input.id);
      this.sql(
        "INSERT INTO notification_watches(device,id,value) VALUES(?,?,?)",
        device,
        input.id,
        JSON.stringify({ ...input, device, createdAt: now }),
      );
      if (firstWatch) {
        // An idle hub need not scan the months before this fresh opt-in. Preserve today's
        // reservations so repeated stop/start cannot reset the daily budget.
        const state = this.runtime(now);
        state.cursor = { at: new Date(now - L.overlapMs).toISOString(), id: 0 };
        state.windowActive = false;
        state.work = null;
        state.lastCheck = null;
        this.put("runtime", state);
      }
    });
    return true;
  }
  removeWatch(device: string, id: string): void {
    this.sql("DELETE FROM notification_deliveries WHERE device=? AND watch=?", device, id);
    this.sql("DELETE FROM notification_watches WHERE device=? AND id=?", device, id);
  }
  removeDevice(id: string): void {
    this.storage.transactionSync(() => {
      this.sql("DELETE FROM notification_deliveries WHERE device=?", id);
      this.sql("DELETE FROM notification_watches WHERE device=?", id);
      this.sql("DELETE FROM notification_devices WHERE id=?", id);
    });
  }
  enqueue(id: string, watch: Watch, payload: string, now: number): void {
    if (
      this.ledgerFull() &&
      !this.sql("SELECT 1 FROM notification_deliveries WHERE id=?", id).length
    )
      throw new Error("notification_queue_full");
    this.sql(
      "INSERT INTO notification_deliveries(id,device,watch,payload,created,due) SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM notification_deliveries WHERE id=?)",
      id,
      watch.device,
      watch.id,
      payload,
      now,
      now,
      id,
    );
  }
  nextDelivery(now: number): Delivery | null {
    return (
      (this.sql(
        "SELECT * FROM notification_deliveries WHERE status='pending' AND due<=? ORDER BY due LIMIT 1",
        now,
      )[0] as unknown as Delivery) ?? null
    );
  }
  prune(now: number): void {
    for (const row of this.sql<{ id: string }>(
      "SELECT id FROM notification_devices WHERE renewed<? LIMIT 5",
      now - L.deviceExpiryMs,
    ))
      this.removeDevice(row.id);
    this.sql(
      "DELETE FROM notification_deliveries WHERE id IN (SELECT id FROM notification_deliveries WHERE created<? ORDER BY created LIMIT 100)",
      now - L.retentionMs,
    );
  }
  ledgerFull(): boolean {
    return (
      Number(
        this.sql<{ deliveries: number }>("SELECT deliveries FROM notification_counts WHERE id=1")[0]
          .deliveries,
      ) >= L.ledgerLimit
    );
  }
  keys(): VapidKey | null {
    return this.get<VapidKey>("vapid");
  }
}
