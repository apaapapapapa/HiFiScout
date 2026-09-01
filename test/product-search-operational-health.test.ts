import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

const script = readFileSync(
  new URL("../scripts/product-search-identity-health.sh", import.meta.url),
  "utf8",
);

test("Product Search identity health avoids correlated peer scans", () => {
  assert.match(script, /LEFT JOIN product_identity_resolutions r/);
  assert.match(script, /LEFT JOIN knowledge_catalog_products kp/);
  assert.match(script, /AND kp\.id IS NULL/);
  assert.match(
    script,
    /COUNT\(DISTINCT CASE\s+WHEN p\.primary_category_id NOT IN \('other', 'unclassified'\) THEN p\.primary_category_id\s+ELSE NULL\s+END\) <= 1/s,
  );
  assert.doesNotMatch(script, /FROM products peer/);
});

test("Product Search identity health allows one post-deploy repair tick", () => {
  assert.match(script, /read_split_groups\(\)/);
  assert.equal([...script.matchAll(/split_groups="\$\(read_split_groups\)"/g)].length, 2);
  assert.match(script, /GENERAL_CRON_INTERVAL_SECONDS=300/);
  assert.match(script, /PROJECTION_REPAIR_GRACE_SECONDS=45/);
  assert.match(script, /sleep "\$wait_seconds"/);
  assert.match(script, /Persistent drift is still reported by the second observation/);
});
