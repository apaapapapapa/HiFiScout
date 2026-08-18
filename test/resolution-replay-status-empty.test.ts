import test from "node:test";
import assert from "node:assert/strict";

import { resolutionReplayStatus } from "../src/db/resolution-replay-status-repository.js";
import { captureDatabase } from "./helpers/d1.js";

test("resolution replay status treats an empty active catalog as fully converged", async () => {
  const db = captureDatabase((statement) => {
    if (statement.sql.includes("FROM products p")) {
      return [
        {
          active_listings: 0,
          stale_manufacturer: 0,
          stale_model: 0,
          stale_category: 0,
          stale_identity: 0,
          projection_dirty: 0,
          stale_listings: 0,
        },
      ];
    }
    return [{ pending: 0, processing: 0, resolved: 0, failed: 0 }];
  });

  const status = await resolutionReplayStatus(db);
  assert.equal(status.overall.complete, true);
  assert.equal(status.overall.progressPercent, 100);
  assert.equal(status.stages.category.progressPercent, 100);
});
