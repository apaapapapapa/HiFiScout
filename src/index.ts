/**
 * Worker composition root.
 *
 * The three handlers Cloudflare invokes are wired here without importing Cloudflare-runtime-only
 * modules. `src/worker.ts` is the deployed module and adds named RPC entrypoints around this
 * testable composition root.
 */

import { handleHttp } from "./http/router.js";
import { handleQueue } from "./queue.js";
import type { WorkerQueueMessage } from "./queue.js";
import { handleScheduled } from "./scheduled.js";

export default {
  fetch: handleHttp,
  scheduled: handleScheduled,
  queue: handleQueue,
} satisfies ExportedHandler<Env, WorkerQueueMessage>;
