import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { isMetaResponse } from "../frontend/api-client.js";

const baseMeta = {
  status: "healthy",
  shops: [],
  manufacturers: [],
  categories: [],
  categoryFacets: [],
};

test("meta response accepts legacy payloads without counted manufacturer facets", () => {
  assert.equal(isMetaResponse(baseMeta), true);
});

test("meta response accepts valid counted manufacturer facets", () => {
  assert.equal(
    isMetaResponse({
      ...baseMeta,
      manufacturerFacets: [
        { name: "LUXMAN", activeProductCount: 3 },
        { name: "TAD", activeProductCount: 0 },
      ],
    }),
    true,
  );
});

test("meta response rejects malformed manufacturer facet collections and values", () => {
  assert.equal(isMetaResponse({ ...baseMeta, manufacturerFacets: null }), false);
  assert.equal(isMetaResponse({ ...baseMeta, manufacturerFacets: { length: 1 } }), false);
  assert.equal(
    isMetaResponse({ ...baseMeta, manufacturerFacets: [{ name: 123, activeProductCount: 1 }] }),
    false,
  );
  assert.equal(
    isMetaResponse({
      ...baseMeta,
      manufacturerFacets: [{ name: "LUXMAN", activeProductCount: -1 }],
    }),
    false,
  );
  assert.equal(
    isMetaResponse({
      ...baseMeta,
      manufacturerFacets: [{ name: "LUXMAN", activeProductCount: 1.5 }],
    }),
    false,
  );
});

test("meta response validates optional shop active product counts when present", () => {
  const shop = {
    key: "hifido",
    name: "ハイファイ堂",
    enabled: true,
    intervalMinutes: 60,
    sync: null,
    health: null,
  };

  assert.equal(isMetaResponse({ ...baseMeta, shops: [{ ...shop, activeProductCount: 4 }] }), true);
  assert.equal(
    isMetaResponse({ ...baseMeta, shops: [{ ...shop, activeProductCount: -1 }] }),
    false,
  );
});
