export interface CatalogAdminListOptions {
  query: string;
  manufacturerId: string;
  categoryId: string;
  afterId: number;
  limit: number;
}

export interface CatalogAdminUpdateInput {
  canonicalName: string;
  lifecycleStatus: "unknown" | "active" | "discontinued";
  primaryCategoryId: string;
}

export type CatalogAdminProductExportScope = "active" | "all";

export interface CatalogAdminProductExportOptions {
  scope: CatalogAdminProductExportScope;
  afterId: number;
  limit: number;
}

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

export interface CatalogAdminProductExportPage {
  items: CatalogAdminProductExportRow[];
  nextAfterId: number | null;
}

export interface CatalogAdminRpc {
  listProducts(options: CatalogAdminListOptions): Promise<unknown>;
  updateProduct(productId: number, input: CatalogAdminUpdateInput): Promise<unknown>;
  exportProductAuditPage(
    options: CatalogAdminProductExportOptions,
  ): Promise<CatalogAdminProductExportPage>;
}
