import { WorkerEntrypoint } from "cloudflare:workers";

import worker from "./index.js";
import type {
  CatalogAdminCreateInput,
  CatalogAdminDuplicateListOptions,
  CatalogAdminListOptions,
  CatalogAdminRpc,
  CatalogAdminUpdateInput,
} from "./admin/contracts.js";
import { listKnowledgeCatalogDuplicates } from "./db/knowledge-catalog-duplicate-repository.js";
import {
  listKnowledgeCatalogAdminProducts,
  updateKnowledgeCatalogAdminProduct,
} from "./db/knowledge-catalog-admin-repository.js";
import {
  createKnowledgeCatalogAdminProduct,
  listKnowledgeCatalogAdminCandidates,
  mergeKnowledgeCatalogAdminProducts,
  verifyKnowledgeCatalogAdminCandidate,
} from "./db/knowledge-catalog-admin-operations.js";
import {
  listListingAdminProducts,
  updateListingAdminProduct,
} from "./db/listing-admin-repository.js";
import {
  listProductCorrectionReports,
  updateProductCorrectionReport,
} from "./db/product-correction-report-repository.js";
import type {
  ProductCorrectionReportAdminAction,
  ProductCorrectionReportListOptions,
} from "./db/product-correction-report-repository.js";
import { listProductAuditExportPage } from "./db/product-audit-export-repository.js";
import {
  createProductAuditExportDownloadResponse,
  getProductAuditExportJob,
  latestProductAuditExportJob,
  startProductAuditExport,
} from "./product-audit-export/service.js";
import {
  createKnowledgeCatalogExportDownloadResponse,
  getKnowledgeCatalogExportJob,
  latestKnowledgeCatalogExportJob,
  startKnowledgeCatalogExport,
} from "./knowledge-catalog-export/service.js";
import type { ProductAuditExportScope } from "./product-audit-export/types.js";
import type { ListingAdminListOptions, ListingAdminUpdateInput } from "./http/listing-admin.js";

/**
 * Internal Catalog Admin capability. Cloudflare exposes this class only through the named Service
 * Binding configured on the dedicated Access-protected admin Worker; it has no public HTTP route.
 */
export class CatalogAdminService extends WorkerEntrypoint<Env> implements CatalogAdminRpc {
  async listProducts(options: CatalogAdminListOptions) {
    return listKnowledgeCatalogAdminProducts(this.env.DB, options);
  }

  async listCandidates(options: CatalogAdminListOptions) {
    return listKnowledgeCatalogAdminCandidates(this.env.DB, options);
  }

  async listDuplicates(options: CatalogAdminDuplicateListOptions) {
    return listKnowledgeCatalogDuplicates(this.env.DB, options);
  }

  async createProduct(input: CatalogAdminCreateInput) {
    return createKnowledgeCatalogAdminProduct(this.env.DB, input);
  }

  async verifyCandidate(candidateId: number, input: CatalogAdminCreateInput) {
    return verifyKnowledgeCatalogAdminCandidate(this.env.DB, candidateId, input);
  }

  async updateProduct(productId: number, input: CatalogAdminUpdateInput) {
    return updateKnowledgeCatalogAdminProduct(this.env.DB, productId, input);
  }

  async mergeProducts(targetProductId: number, sourceProductId: number) {
    return mergeKnowledgeCatalogAdminProducts(this.env.DB, targetProductId, sourceProductId);
  }

  async listListings(options: ListingAdminListOptions) {
    return listListingAdminProducts(this.env.DB, options);
  }

  async updateListing(listingId: number, input: ListingAdminUpdateInput) {
    return updateListingAdminProduct(this.env.DB, listingId, input);
  }

  async listCorrectionReports(options: ProductCorrectionReportListOptions) {
    return listProductCorrectionReports(this.env.DB, options);
  }

  async updateCorrectionReport(
    reportId: number,
    action: ProductCorrectionReportAdminAction,
    note: string,
  ) {
    return updateProductCorrectionReport(this.env.DB, reportId, action, note);
  }

  async startKnowledgeCatalogExport() {
    return startKnowledgeCatalogExport(this.env.DB, this.env.PRODUCT_AUDIT_EXPORT_QUEUE);
  }

  async latestKnowledgeCatalogExportJob() {
    return latestKnowledgeCatalogExportJob(this.env.DB, this.env.PRODUCT_AUDIT_EXPORT_QUEUE);
  }

  async getKnowledgeCatalogExportJob(jobId: string) {
    return getKnowledgeCatalogExportJob(this.env.DB, jobId);
  }

  async downloadKnowledgeCatalogExport(jobId: string): Promise<Response> {
    return createKnowledgeCatalogExportDownloadResponse(
      this.env.DB,
      this.env.EVIDENCE_BUCKET,
      jobId,
    );
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
