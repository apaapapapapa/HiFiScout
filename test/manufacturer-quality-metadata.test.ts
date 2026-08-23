import assert from "node:assert/strict";
import { test } from "vitest";
import { manufacturerIdForFilter } from "../src/catalog/manufacturers.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { parsedProduct } from "./helpers/fixtures.js";

test("known manufacturer records canonical alias resolution evidence", () => {
  const product = normalizeCatalogProduct(
    parsedProduct({
      title: "LUXMAN L-509Z",
      manufacturer: "ラックスマン",
      rawCategory: "プリメインアンプ",
    }),
  );

  assert.equal(product.manufacturerId, "luxman");
  assert.ok(product.metadata.manufacturerNormalization);
  assert.equal(product.metadata.manufacturerNormalization.matchedAlias, true);
});

test("unknown manufacturer fallback is explicitly unresolved for quality metrics", () => {
  const product = normalizeCatalogProduct(
    parsedProduct({
      title: "Example Model X",
      manufacturer: "Example Unknown Audio",
      rawCategory: "その他",
    }),
  );

  assert.equal(product.manufacturerId, manufacturerIdForFilter("Example Unknown Audio"));
  assert.equal(product.manufacturerResolutionStatus, "unresolved");
  assert.equal(product.manufacturerResolutionMethod, "none");
  assert.ok(product.metadata.manufacturerNormalization);
  assert.equal(product.metadata.manufacturerNormalization.matchedAlias, false);
});
