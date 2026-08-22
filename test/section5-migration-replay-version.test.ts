import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../migrations/0042_remediate_product_identity_section5.sql", import.meta.url),
  "utf8",
);

test("section 5 migration marks manufacturer rows stale without violating the positive-version constraint", () => {
  assert.match(migration, /SET\s+manufacturer_resolver_version\s*=\s*5\b/u);
  assert.doesNotMatch(migration, /SET\s+manufacturer_resolver_version\s*=\s*0\b/u);
});
