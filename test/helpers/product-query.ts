import { parseProductQuery } from "../../src/api/product-query.js";
import type { ProductQuery } from "../../src/api/product-query.js";

/**
 * Builds the normalized query the Worker hands to the search repository.
 *
 * Tests go through the real parser rather than hand-building a `ProductQuery` so query-string
 * defaulting and clamping stay part of what they exercise.
 */
export function productQuery(search = ""): ProductQuery {
  return parseProductQuery(new URL(`https://example.test/api/products${search}`));
}
