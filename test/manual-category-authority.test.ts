import assert from "node:assert/strict";
import { test } from "vitest";

import { knowledgeCatalogKey } from "../src/catalog/knowledge-catalog.js";
import { findManualVerifiedCategoryMatches } from "../src/db/manual-category-authority-repository.js";
import { captureDatabase } from "./helpers/d1.js";

const SOTM_MODEL = "sNH-10G (クロック機能及びマスタークロック入力機能モデル、50Ω、12V)";

test("manual category authority accepts only candidate exact/explicit-alias models", async () => {
  const db = captureDatabase((statement) => {
    if (/FROM knowledge_catalog_products kp/.test(statement.sql)) {
      return [
        {
          id: 224,
          manufacturer_id: "sotm",
          canonical_model: SOTM_MODEL,
          normalized_model: "SNH-10G (クロック機能及びマスタークロック入力機能モデル、50Ω、12V)",
          canonical_name: "sNH-10G 50Ω",
          category_id: "network_switch",
        },
      ];
    }
    if (/FROM knowledge_catalog_aliases/.test(statement.sql)) {
      return [
        {
          product_id: 224,
          normalized_alias: "SNH-10G MANUAL ALIAS",
        },
      ];
    }
    return [];
  });

  const products = [
    {
      manufacturer_id: "sotm",
      model: SOTM_MODEL,
      model_resolution_status: "candidate",
    },
    {
      manufacturer_id: "sotm",
      model: "sNH-10G MANUAL ALIAS",
      model_resolution_status: "candidate",
    },
    {
      manufacturer_id: "sotm",
      model: "sNH-10G DERIVED PRESENTATION",
      model_resolution_status: "candidate",
    },
    {
      manufacturer_id: "sotm",
      model: SOTM_MODEL,
      model_resolution_status: "resolved",
    },
  ];

  const matches = await findManualVerifiedCategoryMatches(db, products);
  const exactKey = knowledgeCatalogKey("sotm", SOTM_MODEL);
  const aliasKey = knowledgeCatalogKey("sotm", "sNH-10G MANUAL ALIAS");
  const derivedKey = knowledgeCatalogKey("sotm", "sNH-10G DERIVED PRESENTATION");

  assert.equal(matches.get(exactKey)?.matchType, "exact");
  assert.deepEqual(matches.get(exactKey)?.categoryIds, ["network_switch"]);
  assert.equal(matches.get(aliasKey)?.matchType, "alias");
  assert.equal(matches.has(derivedKey), false);
  assert.equal(matches.size, 2);
});

test("ambiguous manual aliases are never authoritative", async () => {
  const db = captureDatabase((statement) => {
    if (/FROM knowledge_catalog_products kp/.test(statement.sql)) {
      return [
        {
          id: 224,
          manufacturer_id: "sotm",
          canonical_model: SOTM_MODEL,
          normalized_model: "SNH-10G 50OHM",
          canonical_name: "sNH-10G 50Ω",
          category_id: "network_switch",
        },
        {
          id: 225,
          manufacturer_id: "sotm",
          canonical_model: "sNH-10G 75Ω",
          normalized_model: "SNH-10G 75OHM",
          canonical_name: "sNH-10G 75Ω",
          category_id: "network_switch",
        },
      ];
    }
    if (/FROM knowledge_catalog_aliases/.test(statement.sql)) {
      return [
        { product_id: 224, normalized_alias: "SNH-10G SHARED" },
        { product_id: 225, normalized_alias: "SNH-10G SHARED" },
      ];
    }
    return [];
  });

  const matches = await findManualVerifiedCategoryMatches(db, [
    {
      manufacturer_id: "sotm",
      model: "sNH-10G SHARED",
      model_resolution_status: "candidate",
    },
  ]);

  assert.equal(matches.size, 0);
});
