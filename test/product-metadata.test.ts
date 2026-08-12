import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMetadataJson } from "../src/db/product-metadata-repository.js";

test("product metadata is stored as stable JSON", () => {
  assert.equal(
    normalizeMetadataJson({ warranty: "6 months", storeName: "Tokyo", rank: "A" }),
    '{"rank":"A","storeName":"Tokyo","warranty":"6 months"}',
  );
});

test("missing or non-object metadata becomes an empty object", () => {
  assert.equal(normalizeMetadataJson(undefined), "{}");
  assert.equal(normalizeMetadataJson(null), "{}");
  assert.equal(normalizeMetadataJson(["not", "allowed"]), "{}");
});

test("oversized product metadata is rejected", () => {
  assert.throws(
    () => normalizeMetadataJson({ note: "x".repeat(9000) }),
    /product metadata exceeds 8192 bytes/,
  );
});
