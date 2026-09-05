import type {
  ProductAuditExportJob,
  ProductAuditExportScope,
} from "../product-audit-export/types.js";
import type { KnowledgeCatalogExportJob } from "../knowledge-catalog-export/types.js";

export interface CatalogAdminListOptions {
  query: string;
  manufacturerId: string;
  categoryId: string;
  afterId: number;
  limit: number;
}

export interface CatalogAdminDuplicateListOptions {
  manufacturerId: string;
  afterKey: string;
  limit: number;
}

export interface CatalogAdminUpdateInput {
  canonicalName: string;
  lifecycleStatus: "unknown" | "active" | "discontinued";
  primaryCategoryId: string;
}

export interface CatalogAdminCreateInput extends CatalogAdminUpdateInput {
  manufacturerId: string;
  canonicalModel: string;
  sourceUrl: string;
}

export type CatalogAdminProductExportScope = ProductAuditExportScope;

/** One seller listing enriched with the identity/search state an AI needs for data-quality review. */
export interface CatalogAdminProductExportRow {
  listingId: number;
  shopKey: string;
  sourceId: string;
  sourceUrl: string;
  isActive: number;
  stockStatus: string;
  priceYen: number | null;
  conditionText: string;
  title: string;
  rawManufacturer: string;
  manufacturer: string;
  manufacturerId: string;
  canonicalManufacturerId: string;
  manufacturerResolutionStatus: string;
  manufacturerResolutionMethod: string;
  manufacturerResolutionConfidence: string;
  rawModel: string;
  model: string;
  normalizedModel: string;
  modelResolutionStatus: string;
  modelResolutionMethod: string;
  modelResolutionConfidence: string;
  rawCategory: string;
  category: string;
  primaryCategoryId: string;
  categoryIds: string;
  classificationStatus: string;
  searchEntityKey: string;
  searchEntityKind: string;
  searchEntityPrimaryCategoryId: string;
  searchEntityOfferCount: number | null;
  searchEntityShopCount: number | null;
  identityStatus: string;
  identityMatchMethod: string;
  identityConfidence: string;
  identityCatalogProductId: number | null;
  identityCandidateCatalogProductId: number | null;
  catalogCanonicalName: string;
  catalogCanonicalModel: string;
  catalogPrimaryCategoryId: string;
  candidateCatalogCanonicalName: string;
  candidateCatalogCanonicalModel: string;
  candidateCatalogPrimaryCategoryId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  lastActivityAt: string;
  sourcePublishedAt: string;
}

export interface CatalogAdminRpc {
  listProducts(options: CatalogAdminListOptions): Promise<unknown>;
  listCandidates(options: CatalogAdminListOptions): Promise<unknown>;
  listDuplicates(options: CatalogAdminDuplicateListOptions): Promise<unknown>;
  createProduct(input: CatalogAdminCreateInput): Promise<unknown>;
  verifyCandidate(candidateId: number, input: CatalogAdminCreateInput): Promise<unknown>;
  updateProduct(productId: number, input: CatalogAdminUpdateInput): Promise<unknown>;
  mergeProducts(targetProductId: number, sourceProductId: number): Promise<unknown>;
  startKnowledgeCatalogExport(): Promise<KnowledgeCatalogExportJob>;
  latestKnowledgeCatalogExportJob(): Promise<KnowledgeCatalogExportJob | null>;
  getKnowledgeCatalogExportJob(jobId: string): Promise<KnowledgeCatalogExportJob | null>;
  downloadKnowledgeCatalogExport(jobId: string, part?: number): Promise<Response>;
  startProductAuditExport(scope: ProductAuditExportScope): Promise<ProductAuditExportJob>;
  latestProductAuditExportJob(
    scope: ProductAuditExportScope,
  ): Promise<ProductAuditExportJob | null>;
  getProductAuditExportJob(jobId: string): Promise<ProductAuditExportJob | null>;
  downloadProductAuditExport(jobId: string, part?: number): Promise<Response>;
}
