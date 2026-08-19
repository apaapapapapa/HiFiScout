/**
 * Worker composition root.
 *
 * The three entrypoints Cloudflare invokes, wired to the modules that implement them. Everything
 * else — routing, cron policy, queue identification — lives beside the code it coordinates.
 *
 * The export shape itself is a runtime contract: the property names `fetch`, `scheduled` and
 * `queue` are what the runtime looks for, and `satisfies` checks their signatures without
 * widening the object's type.
 */

import { handleHttp } from "./http/catalog-admin-router.js";
import { handleQueue } from "./queue.js";
import type { WorkerQueueMessage } from "./queue.js";
import { handleScheduled } from "./scheduled.js";

export default {
  fetch: handleHttp,
  scheduled: handleScheduled,
  queue: handleQueue,
} satisfies ExportedHandler<Env, WorkerQueueMessage>;
