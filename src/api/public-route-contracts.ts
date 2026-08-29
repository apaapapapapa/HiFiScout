import { PRODUCT_QUERY_PARAMETERS } from "./product-query.js";
import { SUGGEST_QUERY_PARAMETERS } from "./suggest-query.js";
import { defineRoute } from "./route-contract.js";
import type { JsonSchema } from "./route-contract.js";

const nullableInteger: JsonSchema = { type: ["integer", "null"] };
const nullableString: JsonSchema = { type: ["string", "null"] };
const stockStatus: JsonSchema = {
  type: "string",
  enum: ["in_stock", "sold_out", "unknown"],
};

export const PUBLIC_API_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  ApiError: {
    type: "object",
    additionalProperties: false,
    properties: { error: { type: "string" } },
    required: ["error"],
  },
  ProductOffer: {
    type: "object",
    additionalProperties: false,
    properties: {
      listing_product_id: { type: "integer" },
      shop_key: { type: "string" },
      source_url: { type: "string", format: "uri" },
      title: { type: "string" },
      condition_text: { type: "string" },
      presentation_color: { type: "string" },
      price_yen: nullableInteger,
      previous_price_yen: nullableInteger,
      stock_status: stockStatus,
      first_seen_at: { type: "string", format: "date-time" },
      last_seen_at: { type: "string", format: "date-time" },
      last_activity_at: nullableString,
      source_published_at: nullableString,
    },
    required: [
      "listing_product_id",
      "shop_key",
      "source_url",
      "title",
      "condition_text",
      "presentation_color",
      "price_yen",
      "previous_price_yen",
      "stock_status",
      "first_seen_at",
      "last_seen_at",
      "last_activity_at",
      "source_published_at",
    ],
  },
  ProductSearchItem: {
    type: "object",
    additionalProperties: false,
    properties: {
      key: { type: "string", pattern: "^[a-z]-[0-9]+$" },
      identity_kind: {
        type: "string",
        enum: ["catalog", "unresolved_listing"],
      },
      catalog_product_id: nullableInteger,
      manufacturer: { type: "string" },
      manufacturer_id: { type: "string" },
      model: { type: "string" },
      presentation_colors: { type: "array", items: { type: "string" } },
      primary_category_id: { type: "string" },
      category_ids: { type: "array", items: { type: "string" } },
      direct_category_ids: { type: "array", items: { type: "string" } },
      direct_categories: { type: "array", items: { type: "string" } },
      category: { type: "string" },
      offer_count: { type: "integer", minimum: 0 },
      in_stock_offer_count: { type: "integer", minimum: 0 },
      sold_out_offer_count: { type: "integer", minimum: 0 },
      shop_count: { type: "integer", minimum: 0 },
      lowest_price_yen: nullableInteger,
      highest_price_yen: nullableInteger,
      latest_activity_at: nullableString,
      newest_listed_at: nullableString,
      has_new_offer: { type: "boolean" },
      has_price_drop: { type: "boolean" },
      representative_offer: {
        anyOf: [{ $ref: "#/components/schemas/ProductOffer" }, { type: "null" }],
      },
    },
    required: [
      "key",
      "identity_kind",
      "catalog_product_id",
      "manufacturer",
      "manufacturer_id",
      "model",
      "primary_category_id",
      "category",
      "offer_count",
      "in_stock_offer_count",
      "sold_out_offer_count",
      "shop_count",
      "lowest_price_yen",
      "highest_price_yen",
      "latest_activity_at",
      "newest_listed_at",
      "has_new_offer",
      "has_price_drop",
      "representative_offer",
    ],
  },
  ProductSearchResponse: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        items: { $ref: "#/components/schemas/ProductSearchItem" },
      },
      hasMore: { type: "boolean" },
      nextCursor: nullableString,
      totalCount: nullableInteger,
      totalPages: { type: "integer", minimum: 0 },
    },
    required: ["items", "hasMore", "nextCursor"],
  },
  SuggestResponse: {
    type: "object",
    additionalProperties: false,
    properties: {
      suggestions: { type: "array", items: { type: "string" } },
    },
    required: ["suggestions"],
  },
};

export const PRODUCT_SEARCH_ROUTE = defineRoute({
  id: "searchProducts",
  method: "GET",
  path: "/api/product-search",
  summary: "Search aggregated products",
  description:
    "Searches product-level entities and returns the matching offers aggregated under each product.",
  tags: ["Search"],
  query: PRODUCT_QUERY_PARAMETERS,
  responses: {
    200: {
      description: "A page of matching product entities.",
      schema: { $ref: "#/components/schemas/ProductSearchResponse" },
    },
    400: {
      description: "The query string is invalid.",
      schema: { $ref: "#/components/schemas/ApiError" },
    },
    429: {
      description: "The public API rate limit was exceeded.",
      schema: { $ref: "#/components/schemas/ApiError" },
    },
  },
});

export const SUGGEST_ROUTE = defineRoute({
  id: "suggestProducts",
  method: "GET",
  path: "/api/suggest",
  summary: "Suggest product search terms",
  description: "Returns a bounded typeahead list for the normalized free-text query.",
  tags: ["Search"],
  query: SUGGEST_QUERY_PARAMETERS,
  responses: {
    200: {
      description: "Search suggestions.",
      schema: { $ref: "#/components/schemas/SuggestResponse" },
    },
    400: {
      description: "The query string is invalid.",
      schema: { $ref: "#/components/schemas/ApiError" },
    },
    429: {
      description: "The public API rate limit was exceeded.",
      schema: { $ref: "#/components/schemas/ApiError" },
    },
  },
});

export const PUBLIC_API_ROUTE_CONTRACTS = [PRODUCT_SEARCH_ROUTE, SUGGEST_ROUTE] as const;
