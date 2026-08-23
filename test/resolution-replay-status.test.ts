import { test } from "vitest";
import assert from "node:assert/strict";

import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import { resolutionReplayStatus } from "../src/db/resolution-replay-status-repository.js";
import { captureDatabase } from "./helpers/d1.js";

test("resolution replay status reports generic per-stage version progress and queue state", async () => {
  const db = captureDatabase((statement) => {
    if (statement.sql.includes("FROM products p")) {
      return [
        {
          active_listings: 100,
          stale_manufacturer: 5,
          stale_model: 10,
          stale_category: 25,
          stale_identity: 20,
          projection_dirty: 3,
          stale_listings: 30,
        },
      ];
    }
    if (statement.sql.includes("FROM data_quality_remediation_queue")) {
      return [{ pending: 28, processing: 2, resolved: 400, failed: 0 }];
    }
    return [];
  });

  const status = await resolutionReplayStatus(db);

  assert.equal(status.activeListings, 100);
  assert.deepEqual(status.versions, RESOLUTION_VERSIONS);
  assert.deepEqual(status.stages.category, {
    targetVersion: RESOLUTION_VERSIONS.category,
    upToDate: 75,
    stale: 25,
    progressPercent: 75,
  });
  assert.deepEqual(status.overall, {
    upToDateListings: 70,
    staleListings: 30,
    staleSignals: 63,
    progressPercent: 70,
    complete: false,
    blocked: false,
  });
  assert.deepEqual(status.queue, { pending: 28, processing: 2, resolved: 400, failed: 0 });
  assert.deepEqual(db.calls[0]?.binds, [
    RESOLUTION_VERSIONS.manufacturer,
    RESOLUTION_VERSIONS.model,
    RESOLUTION_VERSIONS.category,
    RESOLUTION_VERSIONS.identity,
    RESOLUTION_VERSIONS.manufacturer,
    RESOLUTION_VERSIONS.model,
    RESOLUTION_VERSIONS.category,
    RESOLUTION_VERSIONS.identity,
  ]);
});

test("resolution replay status marks a failed non-converged replay as blocked", async () => {
  const db = captureDatabase((statement) => {
    if (statement.sql.includes("FROM products p")) {
      return [
        {
          active_listings: 10,
          stale_manufacturer: 0,
          stale_model: 0,
          stale_category: 1,
          stale_identity: 0,
          projection_dirty: 0,
          stale_listings: 1,
        },
      ];
    }
    return [{ pending: 0, processing: 0, resolved: 9, failed: 1 }];
  });

  const status = await resolutionReplayStatus(db);
  assert.equal(status.overall.complete, false);
  assert.equal(status.overall.blocked, true);
  assert.equal(status.stages.category.progressPercent, 90);
});
