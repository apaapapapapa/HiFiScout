import assert from "node:assert/strict";
import { test } from "vitest";

import { listingAdminCategoryIds } from "../src/db/listing-admin-repository.js";
import { parseListingAdminListQuery, parseListingAdminUpdate } from "../src/http/listing-admin.js";

test("listing admin query canonicalizes filters and defaults to active listings", () => {
  const url = new URL(
    "https://example.test/api/admin/listings?q=D-1000&shopKey=AudioUnion&categoryId=turntable&afterId=12&limit=25",
  );
  assert.deepEqual(parseListingAdminListQuery(url), {
    query: "D-1000",
    shopKey: "audiounion",
    categoryId: "turntable",
    activeOnly: true,
    afterId: 12,
    limit: 25,
  });
});

test("listing admin query accepts all-history scope and rejects invalid filters", () => {
  const all = new URL("https://example.test/api/admin/listings?scope=all");
  assert.equal(parseListingAdminListQuery(all)?.activeOnly, false);

  assert.equal(
    parseListingAdminListQuery(
      new URL("https://example.test/api/admin/listings?categoryId=not-a-category"),
    ),
    null,
  );
  assert.equal(
    parseListingAdminListQuery(new URL("https://example.test/api/admin/listings?scope=deleted")),
    null,
  );
  assert.equal(
    parseListingAdminListQuery(new URL("https://example.test/api/admin/listings?limit=101")),
    null,
  );
});

test("listing admin update accepts only canonical correction fields", () => {
  assert.deepEqual(
    parseListingAdminUpdate({
      manufacturerId: " LUXMAN ",
      model: " D-1000mk2 ",
      primaryCategoryId: "turntable",
    }),
    {
      manufacturerId: "luxman",
      model: "D-1000mk2",
      primaryCategoryId: "turntable",
    },
  );

  assert.deepEqual(parseListingAdminUpdate({ manufacturerId: "" }), { manufacturerId: "" });
  assert.equal(parseListingAdminUpdate({}), null);
  assert.equal(parseListingAdminUpdate({ title: "manual title" }), null);
  assert.equal(parseListingAdminUpdate({ primaryCategoryId: "analog" }), null);
  assert.equal(parseListingAdminUpdate({ manufacturerId: "bad manufacturer id" }), null);
});

test("listing admin category override stores the leaf and its filter ancestors", () => {
  assert.deepEqual(listingAdminCategoryIds("turntable"), ["turntable", "analog"]);
  assert.deepEqual(listingAdminCategoryIds("analog"), []);
});
