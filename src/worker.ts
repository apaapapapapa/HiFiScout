import { WorkerEntrypoint } from "cloudflare:workers";

import worker from "./index.js";
import type { CatalogAdminListOptions, CatalogAdminUpdateInput } from "./admin/contracts.js";
import {
  listKnowledgeCatalogAdminProducts,
  updateKnowledgeCatalogAdminProduct,
} from "./db/knowledge-catalog-admin-repository.js";
import { listProductAuditExportPage } from "./db/product-audit-export-repository.js";
import {
  createProductAuditExportDownloadResponse,
  getProductAuditExportJob,
  latestProductAuditExportJob,
  startProductAuditExport,
} from "./product-audit-export/service.js";
import type { ProductAuditExportScope } from "./product-audit-export/types.js";

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

  /**
   * @deprecated One-release rollout bridge for an already-deployed admin Worker from PR #251.
   * The new admin UI never calls this method; remove it after both Workers have shipped together.
   */
  async exportProductAuditPage(options: {
    scope: ProductAuditExportScope;
    afterId: number;
    limit: number;
  }) {
    return listProductAuditExportPage(this.env.DB, {
      ...options,
      maxId: Number.MAX_SAFE_INTEGER,
      limit: Math.min(250, options.limit),
    });
  }

  async startProductAuditExport(scope: ProductAuditExportScope) {
    return startProductAuditExport(this.env.DB, this.env.PRODUCT_AUDIT_EXPORT_QUEUE, scope);
  }

  async latestProductAuditExportJob(scope: ProductAuditExportScope) {
    return latestProductAuditExportJob(this.env.DB, this.env.PRODUCT_AUDIT_EXPORT_QUEUE, scope);
  }

  async getProductAuditExportJob(jobId: string) {
    return getProductAuditExportJob(this.env.DB, jobId);
  }

  async downloadProductAuditExport(jobId: string): Promise<Response> {
    return createProductAuditExportDownloadResponse(this.env.DB, this.env.EVIDENCE_BUCKET, jobId);
  }
}

export default worker;
