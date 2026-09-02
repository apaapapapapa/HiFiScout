/**
 * Worker composition root.
 *
 * The three handlers Cloudflare invokes are wired here without importing Cloudflare-runtime-only
 * modules. `src/worker.ts` is the deployed module and adds named RPC entrypoints around this
 * testable composition root.
 */

import { checkPublicApiRateLimit } from "./api-guard.js";
import {
  canonicalProductQueryUrl,
  parseProductQuery,
  validateProductQuery,
} from "./api/product-query.js";
import { catalogHtmlWithFeedAutodiscovery } from "./http/catalog-feed-autodiscovery.js";
import { handleProductCorrectionReport } from "./http/product-correction-report.js";
import { handleProductPermalink } from "./http/product-permalink.js";
import { json } from "./http/response.js";
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

  if (request.method === "POST" && url.pathname === "/api/product-correction-reports") {
    const rate = await checkPublicApiRateLimit(request, env);
    if (!rate.allowed) return json({ error: "rate_limited" }, { status: 429 });
    return handleProductCorrectionReport(request, env);
  }

  // Cache keys must describe the normalized search, not attacker-controlled query serialization.
  // Invalid queries are left untouched so the HTTP boundary can return its normal validation error.
  if (request.method === "GET" && url.pathname === "/api/product-search") {
    if (!validateProductQuery(url)) {
      const canonicalUrl = canonicalProductQueryUrl(url, parseProductQuery(url));
      request = new Request(canonicalUrl.toString(), request);
    }
  }

  const permalinkResponse = await handleProductPermalink(request, env, ctx);
  if (permalinkResponse) return permalinkResponse;

  const response = await handleHttp(request, env, ctx);
  if (request.method === "GET" && url.pathname === "/") {
    return catalogHtmlWithFeedAutodiscovery(response, url);
  }
  return response;
}

/** Crawl Queues are gone in Phase 6; this entrypoint serves the remaining non-crawl Queue jobs. */
async function handleWorkerQueue(
  batch: MessageBatch<WorkerQueueMessage>,
  env: Env,
): Promise<void> {
  return handleQueue(batch, env);
}

export default {
  fetch: handlePublicHttp,
  scheduled: handleScheduled,
  queue: handleWorkerQueue,
} satisfies ExportedHandler<Env, WorkerQueueMessage>;
