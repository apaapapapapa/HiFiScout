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

export interface CatalogAdminRpc {
  listProducts(options: CatalogAdminListOptions): Promise<unknown>;
  updateProduct(productId: number, input: CatalogAdminUpdateInput): Promise<unknown>;
}
