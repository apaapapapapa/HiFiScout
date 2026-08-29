import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { PRODUCT_QUERY_PARAMETERS } from "../src/api/product-query.js";
import {
  PRODUCT_SEARCH_ROUTE,
  PUBLIC_API_ROUTE_CONTRACTS,
  PUBLIC_API_SCHEMAS,
  SUGGEST_ROUTE,
} from "../src/api/public-route-contracts.js";
import { SUGGEST_QUERY_PARAMETERS } from "../src/api/suggest-query.js";
import { buildOpenApiDocument, routeMatches } from "../src/api/route-contract.js";

test("public route contracts own runtime paths and query metadata", () => {
  assert.equal(PRODUCT_SEARCH_ROUTE.query, PRODUCT_QUERY_PARAMETERS);
  assert.equal(SUGGEST_ROUTE.query, SUGGEST_QUERY_PARAMETERS);
  assert.equal(
    routeMatches(
      PRODUCT_SEARCH_ROUTE,
      new Request("https://example.test/api/product-search?q=TAD"),
    ),
    true,
  );
  assert.equal(
    routeMatches(PRODUCT_SEARCH_ROUTE, new Request("https://example.test/api/suggest?q=TAD")),
    false,
  );
});

test("OpenAPI 3.1 is generated from the runtime route contracts", () => {
  const document = buildOpenApiDocument(PUBLIC_API_ROUTE_CONTRACTS, {
    title: "HiFiScout HTTP API",
    version: "0.1.0",
    schemas: PUBLIC_API_SCHEMAS,
  });

  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(Object.keys(document.paths).sort(), ["/api/product-search", "/api/suggest"]);

  const search = document.paths["/api/product-search"]?.get as {
    operationId?: string;
    parameters?: Array<{ name?: string; schema?: Record<string, unknown> }>;
  };
  assert.equal(search.operationId, "searchProducts");
  const feature = search.parameters?.find((parameter) => parameter.name === "feature");
  assert.deepEqual(feature?.schema, {
    type: "array",
    items: {
      type: "string",
      description:
        "Required product feature. May be repeated or supplied as a comma-separated list.",
      enum: ["dac", "network_playback", "headphone_output", "phono_input"],
      maxLength: 200,
    },
  });

  const productItem = document.components?.schemas.ProductSearchItem;
  assert.deepEqual(productItem?.properties?.price_index, {
    $ref: "#/components/schemas/ProductPriceIndexSummary",
  });
  assert.equal(productItem?.required?.includes("price_index"), false);
  assert.deepEqual(productItem?.properties?.representative_offer?.type, ["object", "null"]);
  assert.ok(document.components?.schemas.ProductPriceIndexSummary);

  const suggest = document.paths["/api/suggest"]?.get as { operationId?: string };
  assert.equal(suggest.operationId, "suggestProducts");
  assert.ok(document.components?.schemas.ProductSearchResponse);
  assert.ok(document.components?.schemas.SuggestResponse);
});
