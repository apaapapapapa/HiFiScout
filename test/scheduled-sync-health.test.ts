import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  CRAWL_ROTATION_CRON,
  GENERAL_CRON,
  measureScheduledSyncHealth,
  scheduledSyncHealthReadReason,
} from "../src/scheduled.js";
import { asQueryableDatabase } from "./helpers/d1.js";

test("GENERAL_CRON owns the authoritative scheduled health cadence", () => {
  assert.equal(
    scheduledSyncHealthReadReason(GENERAL_CRON, { status: "skipped", queued: [] }),
    "general_cron",
  );
  assert.equal(
    scheduledSyncHealthReadReason(GENERAL_CRON, { status: "queued", queued: ["hifido"] }),
    "general_cron",
  );
});

test("ordinary crawl dispatches do not repeat the full health read", () => {
  assert.equal(
    scheduledSyncHealthReadReason(CRAWL_ROTATION_CRON, {
      status: "queued",
      shopKey: "hifido",
    }),
    null,
  );
  assert.equal(
    scheduledSyncHealthReadReason("1,31 * * * *", { status: "skipped", queued: [] }),
    null,
  );
});

test("abnormal crawl outcomes retain an immediate diagnostic health read", () => {
  assert.equal(
    scheduledSyncHealthReadReason(CRAWL_ROTATION_CRON, {
      status: "skipped",
      reason: "dispatch_lease_active",
      shopKey: "hifido",
    }),
    "abnormal_dispatch",
  );
  assert.equal(
    scheduledSyncHealthReadReason("1,31 * * * *", {
      status: "rejected",
      reason: "configuration_missing",
    }),
    "abnormal_dispatch",
  );
});

test("scheduled health measurement reports D1's actual rows_read metadata", async () => {
  const db = asQueryableDatabase({
    prepare(sql: string) {
      assert.equal(sql, "SELECT * FROM shop_sync_state");
      return {
        async all() {
          return {
            results: [],
            meta: { rows_read: 37, rows_written: 0 },
          };
        },
      };
    },
    async batch() {
      return [];
    },
  });

  const measured = await measureScheduledSyncHealth(
    { DB: db },
    new Date("2026-09-02T00:00:00.000Z"),
  );

  assert.equal(measured.rowsRead, 37);
  assert.equal(measured.rowsWritten, 0);
  assert.equal(measured.countedStatements, 1);
  assert.equal(measured.health.checkedAt, "2026-09-02T00:00:00.000Z");
});
