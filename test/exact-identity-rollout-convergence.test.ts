import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vite-plus/test";

const readText = (path: string) => readFile(path, "utf8");

test("exact-identity rollout prioritization uses the production health safety predicate", async () => {
  const [migration, health] = await Promise.all([
    readText("migrations/0082_prioritize_existing_exact_identity_splits.sql"),
    readText("scripts/product-search-identity-health.sh"),
  ]);

  const sharedClauses = [
    "p.is_active = 1",
    "p.model_resolution_status = 'resolved'",
    "COALESCE(p.canonical_manufacturer_id, '') <> ''",
    "COALESCE(p.normalized_model, '') <> ''",
    "kp.id IS NULL",
    "COUNT(*) > 1",
    "COUNT(DISTINCT m.entity_id) > 1",
    "p.primary_category_id NOT IN ('other', 'unclassified')",
    "END) <= 1",
  ];

  for (const clause of sharedClauses) {
    assert.ok(migration.includes(clause), `migration must contain safety clause: ${clause}`);
    assert.ok(health.includes(clause), `health check must contain safety clause: ${clause}`);
  }

  assert.match(migration, /r\.listing_product_id = p\.id\s+AND r\.status = 'matched'/);
  assert.match(migration, /kp\.id = r\.catalog_product_id\s+AND kp\.verification_status = 'verified'/);
});

test("existing splits jump ahead of the broad rollout seed without widening recurring work", async () => {
  const migration = await readText("migrations/0082_prioritize_existing_exact_identity_splits.sql");

  assert.match(migration, /'1970-01-01T00:00:00\.000Z'/);
  assert.match(
    migration,
    /ON CONFLICT\(canonical_manufacturer_id, normalized_model\) DO UPDATE SET\s+marked_at = excluded\.marked_at,\s+claimed_at = NULL;/,
  );
  assert.doesNotMatch(migration, /UPDATE\s+products\b/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM\s+product_search_exact_identity_dirty/i);
  assert.doesNotMatch(migration, /CREATE\s+TRIGGER/i);
});
