import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  USER_CONFIRMED_SWITCH_CATEGORY_ID,
  planManualCategoryAuthority,
} from "../scripts/apply-manual-category-authority.js";

test("manual category authority defers the taxonomy-v3 unclassified sentinel", () => {
  assert.equal(
    planManualCategoryAuthority("unclassified", '["unclassified"]', "unclassified"),
    null,
  );
});

test("manual category authority rebuilds canonical direct and ancestor membership", () => {
  const plan = planManualCategoryAuthority("PRC.DAC", '["PRC.DAC"]', "SIG.NETWORK");
  assert.ok(plan);
  assert.equal(plan.categoryId, "SIG.NETWORK");
  assert.deepEqual(plan.directCategoryIds, ["SIG.NETWORK"]);
  assert.deepEqual(plan.membershipCategoryIds, ["SIG", "SIG.NETWORK"]);
  assert.match(plan.searchAliases, /Audio Network Equipment/);
});

test("manual category authority preserves other bundle direct categories while replacing primary", () => {
  const plan = planManualCategoryAuthority(
    "SRC.DISC",
    '["SRC.DISC","PRC.DAC"]',
    "SRC.STREAMER",
  );
  assert.ok(plan);
  assert.deepEqual(plan.directCategoryIds, ["SRC.STREAMER", "PRC.DAC"]);
  assert.deepEqual(plan.membershipCategoryIds, ["SRC", "SRC.STREAMER", "PRC", "PRC.DAC"]);
  assert.ok(!plan.directCategoryIds.includes("SRC.DISC"));
});

test("manual category authority still rejects non-selectable taxonomy roots", () => {
  assert.throws(
    () => planManualCategoryAuthority("PRC.DAC", '["PRC.DAC"]', "SIG"),
    /non-selectable category SIG/,
  );
});

test("user-confirmed switching hubs use the taxonomy-v3 network product type", () => {
  assert.equal(USER_CONFIRMED_SWITCH_CATEGORY_ID, "SIG.NETWORK");
});
