/**
 * Worker composition root.
 *
 * The three entrypoints Cloudflare invokes are wired to the modules that implement them. The
 * named `CatalogAdminService` entrypoint is deliberately RPC-only: the separately Access-protected
 * admin Worker can reach catalog administration without exposing that API from the public Worker.
 */

import { WorkerEntrypoint } from "cloudflare:workers";

import type { CatalogAdminListOptions, CatalogAdminUpdateInput } from "./admin/contracts.js";
import {
  listKnowledgeCatalogAdminProducts,
  updateKnowledgeCatalogAdminProduct,
} from "./db/knowledge-catalog-admin-repository.js";
import { handleHttp } from "./http/router.js";
import { handleQueue } from "./queue.js";
import type { WorkerQueueMessage } from "./queue.js";
import { handleScheduled } from "./scheduled.js";

/** Internal capability exposed only through a Cloudflare Service Binding. */
export class CatalogAdminService extends WorkerEntrypoint<Env> {
  async listProducts(options: CatalogAdminListOptions) {
    return listKnowledgeCatalogAdminProducts(this.env.DB, options);
  }

  async updateProduct(productId: number, input: CatalogAdminUpdateInput) {
    return updateKnowledgeCatalogAdminProduct(this.env.DB, productId, input);
  }
}

export default {
  fetch: handleHttp,
  scheduled: handleScheduled,
  queue: handleQueue,
} satisfies ExportedHandler<Env, WorkerQueueMessage>;
