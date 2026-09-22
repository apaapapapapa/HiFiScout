import { parseProductQuery } from "../api/product-query.js";
import { matchNotificationListings } from "../db/product-search-repository.js";
import { notificationCandidates, notificationEvents } from "../db/notification-candidates.js";
import type { QueryableDatabase } from "../db/types.js";
import { digest, NOTIFICATION_LIMITS as L, watchAccepts } from "./policy.js";
import type { PushAddress, Watch } from "./policy.js";
import { NotificationStore } from "./storage.js";
import type { Runtime } from "./storage.js";
import { sendPush } from "./web-push.js";
import type { VapidKey } from "./web-push.js";

export type PushSender = (
  address: PushAddress,
  keys: VapidKey,
  payload: string,
  topic: string,
  now: number,
) => ReturnType<typeof sendPush>;

/** Each D1 statement reserves its failure budget before I/O. Unknown meta stops further reads. */
export function notificationDatabase(
  db: QueryableDatabase,
  store: NotificationStore,
  state: Runtime,
): QueryableDatabase {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === "all")
          return async () => {
            if (
              state.unknown ||
              state.queries >= L.statementsPerDay ||
              state.reads + 5000 > L.readsPerDay
            )
              throw new Error("notification_budget_exhausted");
            state.queries++;
            state.reads += 5000;
            store.put("runtime", state);
            const result = await target.all();
            const reads = result.meta?.rows_read;
            if (typeof reads !== "number" || !Number.isFinite(reads) || reads < 0) {
              state.unknown = true;
              store.put("runtime", state);
              throw new Error("notification_usage_unknown");
            }
            state.reads += reads - 5000;
            store.put("runtime", state);
            return result;
          };
        if (["run", "first", "raw"].includes(String(key)))
          return () => {
            throw new Error("notification_unmetered_query");
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return {
    prepare: (sql) => wrap(db.prepare(sql)),
    batch: () => {
      throw new Error("notification_batch_not_allowed");
    },
  };
}

export async function runNotifications(
  store: NotificationStore,
  db: QueryableDatabase,
  keys: VapidKey,
  now: number,
  sender: PushSender = sendPush,
): Promise<number | null> {
  store.prune(now);
  if (!store.watches().length) return null;
  const state = store.runtime(now);
  const deadline = Date.now() + 20_000;
  const metered = notificationDatabase(db, store, state);
  let moreCandidates = false;
  try {
    if (!state.work) {
      if (!state.windowActive) {
        state.until = new Date(now - 120_000).toISOString();
        state.windowActive = true;
      }
      const candidates = await notificationCandidates(metered, state.cursor, state.until);
      state.work = {
        candidates,
        queries: candidates.length ? [...new Set(store.watches().map((watch) => watch.query))] : [],
        index: 0,
      };
      store.put("runtime", state);
    }
    if (store.ledgerFull()) throw new Error("notification_queue_full");
    const work = state.work;
    for (let done = 0; work.index < work.queries.length && done < L.rulesPerAlarm; done++) {
      if (Date.now() >= deadline) break;
      const query = work.queries[work.index];
      const url = new URL("https://notification.invalid/api/product-search");
      url.search = query;
      const rows = await matchNotificationListings(
        metered,
        parseProductQuery(url),
        work.candidates.map((candidate) => candidate.id),
      );
      const events = notificationEvents(rows).filter((event) => event.at >= now - L.retentionMs);
      // Materialize hashes before the atomic outbox/checkpoint commit. Updates during reads are
      // fenced by re-reading each watch, and newly registered watches cannot receive old events.
      const messages: { watch: Watch; id: string; payload: string }[] = [];
      for (const watch of store.watches().filter((watch) => watch.query === query)) {
        for (const event of events.filter((event) => watchAccepts(watch, event))) {
          const id = await digest(`${watch.device}:${watch.id}:${watch.createdAt}:${event.id}`);
          const tag = await digest(`${watch.device}:${event.id}`);
          messages.push({
            watch,
            id,
            payload: JSON.stringify({
              id,
              tag,
              title: `HiFiScout · ${event.kind === "new" ? "新着" : "値下げ"}`,
              body: `${event.title}${event.price === null ? "" : ` / ${event.price.toLocaleString("ja-JP")}円`}`,
              path: `/p/${event.key}`,
              observedAt: event.at,
            }),
          });
        }
      }
      store.storage.transactionSync(() => {
        for (const message of messages) {
          const current = store.watch(message.watch.device, message.watch.id);
          if (
            current &&
            current.createdAt === message.watch.createdAt &&
            current.query === message.watch.query
          )
            store.enqueue(message.id, current, message.payload, now);
        }
        work.index++;
        store.put("runtime", state);
      });
    }
    if (work.index >= work.queries.length) {
      if (work.candidates.length === L.batch) {
        state.cursor = work.candidates.at(-1)!;
        moreCandidates = true;
      } else {
        state.lastCheck = now;
        state.cursor = { at: new Date(Date.parse(state.until) - L.overlapMs).toISOString(), id: 0 };
        state.windowActive = false;
      }
      state.work = null;
    }
    state.error = null;
  } catch (error) {
    state.error =
      error instanceof Error && /^notification_[a-z_]+$/.test(error.message)
        ? error.message
        : "notification_check_failed";
  }
  store.put("runtime", state);

  for (let i = 0; i < L.pushesPerAlarm && state.pushes < L.pushesPerDay; i++) {
    if (Date.now() >= deadline) break;
    const job = store.nextDelivery(now);
    if (!job) break;
    if (job.attempts >= 3) {
      store.sql("UPDATE notification_deliveries SET status='failed',payload='' WHERE id=?", job.id);
      continue;
    }
    const device = store.device(job.device);
    if (!device || !store.watch(job.device, job.watch)) {
      store.sql("DELETE FROM notification_deliveries WHERE id=?", job.id);
      continue;
    }
    // Persist an attempt and retry time before network I/O, including a lost acknowledgement.
    state.pushes++;
    store.storage.transactionSync(() => {
      store.put("runtime", state);
      store.sql(
        "UPDATE notification_deliveries SET attempts=attempts+1,due=? WHERE id=?",
        now + 300_000,
        job.id,
      );
    });
    let result: Awaited<ReturnType<PushSender>>;
    try {
      result = await sender(device.address, keys, job.payload, job.id, now);
    } catch {
      result = "retry";
    }
    if (result === "expired") {
      store.removeDevice(device.id);
      continue;
    }
    if (result === "sent")
      store.sql("UPDATE notification_deliveries SET status='sent',payload='' WHERE id=?", job.id);
    else if (result === "rejected" || job.attempts + 1 >= 3)
      store.sql("UPDATE notification_deliveries SET status='failed',payload='' WHERE id=?", job.id);
    else if (typeof result === "object")
      store.sql("UPDATE notification_deliveries SET due=? WHERE id=?", result.retryAt, job.id);
  }
  if (!store.watches().length) return null;
  const budget =
    state.unknown || state.queries >= L.statementsPerDay || state.reads + 5000 > L.readsPerDay;
  if (budget) return Date.parse(`${state.day}T00:00:00Z`) + 86_400_000;
  return (
    now +
    (state.work || moreCandidates || store.nextDelivery(now) ? L.continuationMs : L.intervalMs)
  );
}
