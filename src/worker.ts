import { WorkerEntrypoint } from "cloudflare:workers";

import worker from "./index.js";
import type { CatalogAdminListOptions, CatalogAdminUpdateInput } from "./admin/contracts.js";
import {
  listKnowledgeCatalogAdminProducts,
  updateKnowledgeCatalogAdminProduct,
} from "./db/knowledge-catalog-admin-repository.js";

/**
 * Internal Catalog Admin capability. Cloudflare exposes this class only through the named Service
 * Binding configured on the dedicated Access-protected admin Worker; it has no public HTTP route.
 */
export class CatalogAdminService extends WorkerEntrypoint<Env> {
  async listProducts(options: CatalogAdminListOptions) {
    return listKnowledgeCatalogAdminProducts(this.env.DB, options);
  }

  async updateProduct(productId: number, input: CatalogAdminUpdateInput) {
    return updateKnowledgeCatalogAdminProduct(this.env.DB, productId, input);
  }
}

export default worker;
