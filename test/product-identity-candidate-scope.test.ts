import { test } from "vitest";
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

test("identity replay can load verified candidates one manufacturer at a time", async () => {
  const db = identityDatabase();

  await syncProductIdentityResolutions(
    db,
    "hifido",
    ["source-a", "source-b", "source-c"],
    "2026-08-16T00:00:00.000Z",
    { candidateManufacturerChunkSize: 1 },
  );

  assert.deepEqual(
    candidateReads(db).map((statement) => statement.binds),
    [["onkyo"], ["kenwood"]],
  );
});

test("normal identity sync keeps manufacturer candidate reads batched by default", async () => {
  const db = identityDatabase();

  await syncProductIdentityResolutions(
    db,
    "hifido",
    ["source-a", "source-b", "source-c"],
    "2026-08-16T00:00:00.000Z",
  );

  assert.deepEqual(
    candidateReads(db).map((statement) => statement.binds),
    [["onkyo", "kenwood"]],
  );
});
