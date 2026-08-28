import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { repairGeneralCronProjectionGaps } from "../src/scheduled.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

test("general cron projection repair is safe when there are no active gaps", async () => {
  const { db } = migratedSqlite();

  const result = await repairGeneralCronProjectionGaps(db);

  // `null` rather than `0`: the scheduled caller deliberately does not buy the outstanding-gap
  // count, which is the one statement in the repair whose cost grows with the whole catalog.
  assert.deepEqual(result, {
    selectedCount: 0,
    repairedCount: 0,
    remainingGapCount: null,
  });
});
