/**
 * Worker composition root.
 *
 * The three handlers Cloudflare invokes are wired here without importing Cloudflare-runtime-only
 * modules. `src/worker.ts` is the deployed module and adds named RPC entrypoints around this
 * testable composition root.
 */

import {
  canonicalProductQueryUrl,
  parseProductQuery,
  validateProductQuery,
} from "./api/product-query.js";
import { handleHttp } from "./http/router.js";
import { handleQueue } from "./queue.js";
import type { WorkerQueueMessage } from "./queue.js";
import { handleScheduled } from "./scheduled.js";

/**
 * Legacy operational admin HTTP routes used a static bearer token on the public Worker. They are
 * retired at the outermost public entrypoint so no bearer value can make those handlers reachable.
 * Administrative UI/RPC capabilities live on the separate Cloudflare Access-protected admin Worker.
 */
async function handlePublicHttp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/admin/")) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  // Cache keys must describe the normalized search, not attacker-controlled query serialization.
  // Invalid queries are left untouched so the HTTP boundary can return its normal validation error.
  if (request.method === "GET" && url.pathname === "/api/product-search") {
    if (!validateProductQuery(url)) {
      const canonicalUrl = canonicalProductQueryUrl(url, parseProductQuery(url));
      request = new Request(canonicalUrl.toString(), request);
    }
  }

  return handleHttp(request, env, ctx);
}

export default {
  fetch: handlePublicHttp,
  scheduled: handleScheduled,
  queue: handleQueue,
} satisfies ExportedHandler<Env, WorkerQueueMessage>;
