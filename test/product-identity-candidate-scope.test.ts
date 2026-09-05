import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { syncProductIdentityResolutions } from "../src/db/product-identity-repository.js";
import { captureDatabase, type CapturedStatement } from "./helpers/d1.js";

const listingRows = [
  {
    id: 1,
    source_id: "source-a",
    canonical_manufacturer_id: "onkyo",
    model: "TX-L55",
    model_resolution_status: "resolved",
    primary_category_id: "integrated_amp",
    classification_status: "classified",
  },
  {
    id: 2,
    source_id: "source-b",
    canonical_manufacturer_id: "kenwood",
    model: "KT-2060",
    model_resolution_status: "resolved",
    primary_category_id: "tuner",
    classification_status: "classified",
  },
  {
    id: 3,
    source_id: "source-c",
    canonical_manufacturer_id: "onkyo",
    model: "Integra T-4500",
    model_resolution_status: "resolved",
    primary_category_id: "tuner",
    classification_status: "classified",
  },
];

function identityDatabase() {
  return captureDatabase((statement: CapturedStatement) => {
    if (
      statement.sql.includes("SELECT id, source_id, canonical_manufacturer_id") &&
      statement.sql.includes("FROM products")
    ) {
      return listingRows;
    }
    return [];
  });
}

function candidateReads(db: ReturnType<typeof identityDatabase>) {
  return db.calls.filter((statement) =>
    statement.sql.includes("FROM knowledge_catalog_products kp"),
  );
}

test("identity replay scopes indexed candidate reads to each manufacturer and its requested model keys", async () => {
  const db = identityDatabase();

  await syncProductIdentityResolutions(
    db,
    "hifido",
    ["source-a", "source-b", "source-c"],
    "2026-08-16T00:00:00.000Z",
    { candidateManufacturerChunkSize: 1 },
  );

  for (const statement of candidateReads(db)) {
    assert.match(statement.sql, /INDEXED BY idx_catalog_products_retrieval_key/);
  }
  assert.match(candidateReads(db).at(-1)!.sql, /LIMIT 64/);
  assert.deepEqual(
    candidateReads(db).map((statement) => statement.binds),
    [
      ["onkyo", "TXL55", "INTEGRAT4500"],
      ["kenwood", "KT2060"],
      ["onkyo", "INT", "INT\uffff"],
    ],
  );
});

test("normal identity sync also bounds fuzzy discovery instead of reading a whole manufacturer", async () => {
  const db = identityDatabase();

  await syncProductIdentityResolutions(
    db,
    "hifido",
    ["source-a", "source-b", "source-c"],
    "2026-08-16T00:00:00.000Z",
  );

  for (const statement of candidateReads(db)) {
    assert.match(statement.sql, /INDEXED BY idx_catalog_products_retrieval_key/);
  }
  assert.match(candidateReads(db).at(-1)!.sql, /LIMIT 64/);
  assert.deepEqual(
    candidateReads(db).map((statement) => statement.binds),
    [
      ["onkyo", "TXL55", "INTEGRAT4500"],
      ["kenwood", "KT2060"],
      ["onkyo", "INT", "INT\uffff"],
    ],
  );
});
