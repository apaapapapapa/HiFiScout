import { readAdminChangeHistory } from "./db/admin-change-history-repository.js";
import {
  parseAdminRestoreSelection,
  previewAdminHistoryRestore,
  restoreAdminHistoryColor,
} from "./admin/change-history.js";
import type { AdminRestoreSelection } from "./api/admin-listing-contracts.js";
import { readAdminListingDiagnosis } from "./db/admin-diagnostics-repository.js";
import {
  readCatalogSpecifications,
  updateCatalogSpecifications,
} from "./db/catalog-specification-repository.js";
import type { CatalogSpecifications } from "./catalog/types.js";
import { WorkerEntrypoint } from "cloudflare:workers";

import worker from "./index.js";
import type { AdminManufacturerQuery } from "./api/admin-manufacturer-contracts.js";
import type { ModelFactWriteInput } from "./catalog/types.js";
import { readModelFactsAdmin, saveModelFactsAdmin } from "./db/model-fact-admin-repository.js";
import { parseModelFactWrite } from "./http/model-fact-admin.js";
import { listAdminManufacturers } from "./db/admin-manufacturer-repository.js";
import { previewAdminCsvChange, applyAdminCsvChange } from "./db/admin-csv-import-repository.js";
import { parseAdminCsvPreview, parseAdminCsvApply } from "./http/admin-csv-import.js";
import type { AdminCsvApplyInput, AdminCsvChange } from "./api/admin-csv-contracts.js";
export { CrawlScheduler } from "./crawler/crawl-scheduler-do.js";
export { PublicSearchCache } from "./http/public-search-cache.js";
import type {
  CatalogAdminCreateInput,
  CatalogAdminDuplicateListOptions,
  CatalogAdminListOptions,
  CatalogAdminRpc,
  CatalogAdminUpdateInput,
} from "./admin/contracts.js";
import { listKnowledgeCatalogDuplicates } from "./db/knowledge-catalog-duplicate-repository.js";
import { readAdminWorkCounts } from "./db/admin-work-counts-repository.js";
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
import { readOfferFactAdmin, updateOfferFactAdmin } from "./db/offer-fact-admin-repository.js";
import { readOfferFactReplay, stepOfferFactReplay } from "./db/offer-fact-replay-repository.js";
import type { OfferFactChanges } from "./catalog/offer-fact-decisions.js";
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
  async getCrawlOverview() {
    return readAdminCrawls(this.env);
  }
  async controlCrawl(shopKey: string, action: "pause" | "resume" | "run") {
    return controlAdminCrawl(this.env, shopKey, action);
  }
  async getWorkCounts(
    cursor: import("./api/admin-work-counts-contract.js").AdminDuplicateCountCursor,
  ) {
    return readAdminWorkCounts(this.env.DB, cursor);
  }
  async getModelFacts(productId: number) {
    return readModelFactsAdmin(this.env.DB, productId);
  }

  async saveModelFacts(productId: number, input: ModelFactWriteInput, actor: string) {
    const parsed = parseModelFactWrite(input);
    if (!parsed) throw new Error("catalog_model_fact_invalid");
    return saveModelFactsAdmin(this.env.DB, productId, parsed, actor);
  }
  async listManufacturers(options: AdminManufacturerQuery) {
    return listAdminManufacturers(this.env.DB, options);
  }
  async previewCsvImport(changes: AdminCsvChange[]) {
    const parsed = parseAdminCsvPreview({ changes });
    if (!parsed) throw new Error("invalid_csv_import");
    const results = [];
    for (const change of parsed) results.push(await previewAdminCsvChange(this.env.DB, change));
    return results;
  }

  async applyCsvImport(input: AdminCsvApplyInput) {
    const parsed = parseAdminCsvApply(input);
    if (!parsed) throw new Error("invalid_csv_import");
    return applyAdminCsvChange(this.env.DB, parsed);
  }

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

  async getSpecifications(productId: number) {
    return readCatalogSpecifications(this.env.DB, productId);
  }

  async updateSpecifications(productId: number, input: CatalogSpecifications) {
    return updateCatalogSpecifications(this.env.DB, productId, input);
  }

  async updateProduct(productId: number, input: CatalogAdminUpdateInput) {
    return updateKnowledgeCatalogAdminProduct(this.env.DB, productId, input);
  }

  async mergeProducts(targetProductId: number, sourceProductId: number) {
    return mergeKnowledgeCatalogAdminProducts(this.env.DB, targetProductId, sourceProductId);
  }

  async getChangeHistory(kind: "listing" | "catalog", id: number) {
    if (!["listing", "catalog"].includes(kind) || !Number.isSafeInteger(id) || id < 1)
      throw new Error("invalid_history_query");
    return readAdminChangeHistory(this.env.DB, kind, id);
  }
  async previewHistoryRestore(input: AdminRestoreSelection) {
    const parsed = parseAdminRestoreSelection(input);
    if (!parsed) throw new Error("invalid_history_restore");
    return previewAdminHistoryRestore(this.env.DB, parsed);
  }
  async restoreHistoryColor(input: AdminRestoreSelection, revision: string, operationId: string) {
    const parsed = parseAdminRestoreSelection(input);
    if (!parsed) throw new Error("invalid_history_restore");
    return restoreAdminHistoryColor(this.env.DB, parsed, revision, operationId);
  }
  async getListingDiagnosis(listingId: number) {
    return readAdminListingDiagnosis(this.env.DB, listingId);
  }

  async listListings(options: ListingAdminListOptions) {
    return listListingAdminProducts(this.env.DB, options);
  }

  async getOfferFacts(listingId: number) {
    return readOfferFactAdmin(this.env.DB, listingId);
  }

  async getOfferFactReplay() {
    return readOfferFactReplay(this.env.DB);
  }

  async stepOfferFactReplay() {
    return stepOfferFactReplay(this.env.DB);
  }

  async updateOfferFacts(listingId: number, changes: OfferFactChanges) {
    return updateOfferFactAdmin(this.env.DB, listingId, changes);
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

  async startKnowledgeCatalogExport(format: DataExportFormat = "csv") {
    return startKnowledgeCatalogExport(
      this.env.DB,
      this.env.PRODUCT_AUDIT_EXPORT_QUEUE,
      new Date(),
      format,
    );
  }

  async latestKnowledgeCatalogExportJob() {
    return latestKnowledgeCatalogExportJob(this.env.DB, this.env.PRODUCT_AUDIT_EXPORT_QUEUE);
  }

  async getKnowledgeCatalogExportJob(jobId: string) {
    return getKnowledgeCatalogExportJob(this.env.DB, jobId);
  }

  async downloadKnowledgeCatalogExport(jobId: string, part = 1): Promise<Response> {
    return createKnowledgeCatalogExportDownloadResponse(
      this.env.DB,
      this.env.EVIDENCE_BUCKET,
      jobId,
      new Date(),
      part,
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

  async startProductAuditExport(scope: ProductAuditExportScope, format: DataExportFormat = "csv") {
    return startProductAuditExport(
      this.env.DB,
      this.env.PRODUCT_AUDIT_EXPORT_QUEUE,
      scope,
      new Date(),
      format,
    );
  }

  async latestProductAuditExportJob(scope: ProductAuditExportScope) {
    return latestProductAuditExportJob(this.env.DB, this.env.PRODUCT_AUDIT_EXPORT_QUEUE, scope);
  }

  async getProductAuditExportJob(jobId: string) {
    return getProductAuditExportJob(this.env.DB, jobId);
  }

  async downloadProductAuditExport(jobId: string, part = 1): Promise<Response> {
    return createProductAuditExportDownloadResponse(
      this.env.DB,
      this.env.EVIDENCE_BUCKET,
      jobId,
      new Date(),
      part,
    );
  }
}

export default worker;
import type { DataExportFormat } from "./export/contracts.js";
import { readAdminCrawls, controlAdminCrawl } from "./crawler/admin-crawl.js";
