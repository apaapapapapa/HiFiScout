import assert from "node:assert/strict";
import test from "node:test";

import { repairGeneralCronProjectionGaps } from "../src/scheduled.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

test("general cron projection repair is safe when there are no active gaps", async () => {
  const { db } = migratedSqlite();

  const result = await repairGeneralCronProjectionGaps(db);

  assert.deepEqual(result, {
    selectedCount: 0,
    repairedCount: 0,
    remainingGapCount: 0,
  });
});
