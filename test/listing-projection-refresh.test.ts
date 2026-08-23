import { test } from "vitest";
import assert from "node:assert/strict";

import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
import { captureDatabase } from "./helpers/d1.js";

test("remediation refresh preserves shop batching and deduplicates repeated inputs", async () => {
  const db = captureDatabase([]);

  await refreshListingProjections(
    db,
    [
      { shop_key: "hifido", source_id: "source-a" },
      { shop_key: "hifido", source_id: "source-b" },
      { shop_key: "hifido", source_id: "source-a" },
    ],
    "2026-08-16T00:00:00.000Z",
  );

  const projectionSourceReads = db.calls.filter(
    (statement) =>
      statement.sql.includes("SELECT id, manufacturer_id, manufacturer, raw_manufacturer") &&
      statement.sql.includes("FROM products"),
  );

  assert.equal(projectionSourceReads.length, 1);
  assert.deepEqual(projectionSourceReads[0]?.binds, ["hifido", "source-a", "source-b"]);
  assert.match(projectionSourceReads[0]?.sql || "", /source_id IN \(\?,\?\)/);
});
