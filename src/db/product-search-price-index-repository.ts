import type { ProductQuery } from "../api/product-query.js";
import type {
  ProductSearchDetailResponse,
  ProductSearchItem,
  ProductSearchResponse,
} from "../api/contracts.js";
import type { ProductPriceIndexSummary } from "../api/price-index.js";
import {
  loadKnowledgeCatalogListingEndObservations,
  loadKnowledgeCatalogPriceIndexes,
} from "./knowledge-catalog-price-index-read.js";
import {
  productSearchDetail as baseProductSearchDetail,
  searchProducts as baseSearchProducts,
} from "./product-search-repository.js";
import type { QueryableDatabase } from "./types.js";

export type PriceIndexedProductSearchItem = ProductSearchItem & {
  /** Omitted until the named asking-sample threshold is met. */
  price_index?: ProductPriceIndexSummary;
};

export interface PriceIndexedProductSearchResponse extends Omit<ProductSearchResponse, "items"> {
  items: PriceIndexedProductSearchItem[];
}

export interface PriceIndexedProductSearchDetailResponse extends Omit<
  ProductSearchDetailResponse,
  "product"
> {
  product: PriceIndexedProductSearchItem;
}

async function addPriceIndexes(
  db: QueryableDatabase,
  items: readonly ProductSearchItem[],
): Promise<PriceIndexedProductSearchItem[]> {
  const summaries = await loadKnowledgeCatalogPriceIndexes(
    db,
    items.map((item) => item.catalog_product_id),
  );
  return items.map((item) => {
    const catalogProductId = item.catalog_product_id;
    const priceIndex = catalogProductId == null ? undefined : summaries.get(catalogProductId);
    return priceIndex ? { ...item, price_index: priceIndex } : item;
  });
}

/** Public `/api/product-search` read with optional, thresholded Knowledge Catalog price evidence. */
export async function searchProducts(
  db: QueryableDatabase,
  query: ProductQuery,
): Promise<PriceIndexedProductSearchResponse> {
  const response = await baseSearchProducts(db, query);
  return { ...response, items: await addPriceIndexes(db, response.items) };
}

/** Public detail adds the bounded, dated listing-end observations needed only by the Step 4 UI. */
export async function productSearchDetail(
  db: QueryableDatabase,
  key: string,
): Promise<PriceIndexedProductSearchDetailResponse | null> {
  const response = await baseProductSearchDetail(db, key);
  if (!response) return null;
  const [product] = await addPriceIndexes(db, [response.product]);
  if (!product) return response;

  const catalogProductId = product.catalog_product_id;
  if (!product.price_index || catalogProductId == null) return { ...response, product };

  const listingEndObservations = await loadKnowledgeCatalogListingEndObservations(
    db,
    catalogProductId,
  );
  return {
    ...response,
    product: {
      ...product,
      price_index: {
        ...product.price_index,
        listing_end_observations: listingEndObservations,
      },
    },
  };
}
