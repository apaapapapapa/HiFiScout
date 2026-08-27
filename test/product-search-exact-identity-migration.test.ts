import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

const deployBackfillMigration = readFileSync(
  new URL("../migrations/0059_repair_split_exact_product_search_identities.sql", import.meta.url),
  "utf8",
);

function normalized(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

test("deploy backfill repairs only split safe exact identities with the current projection shape", () => {
  const backfill = normalized(deployBackfillMigration);

  for (const invariant of [
    "model_resolution_status = 'resolved'",
    "canonical_manufacturer_id",
    "normalized_model",
    "verification_status = 'verified'",
    "COUNT(DISTINCT current_entity_id) > 1",
    "primary_category_id NOT IN ('other', 'unclassified')",
    "ON CONFLICT(listing_product_id) DO UPDATE SET",
  ]) {
    assert.ok(backfill.includes(invariant), invariant);
  }

  // Eligibility must include peers whose membership is temporarily absent. Membership decides
  // whether an existing group is split; it must not narrow category veto or representative choice.
  assert.ok(
    backfill.includes(
      "LEFT JOIN product_search_entity_offers membership ON membership.listing_product_id = p.id",
    ),
  );
  assert.ok(backfill.includes("current_entity_id INTEGER"));
  assert.ok(backfill.includes("WHERE eligible.current_entity_id IS NOT NULL"));

  // Membership-derived projections introduced after the original 0036 backfill must move with the
  // offers, otherwise fixing the split would trade it for stale card/filter state or aggregates.
  for (const projection of [
    "presentation_colors",
    "product_search_entity_categories",
    "direct_category_ids",
    "title_terms",
    "category_terms",
  ]) {
    assert.ok(backfill.includes(projection), projection);
  }

  assert.ok(backfill.includes("migration_0059_eligible"));
  assert.ok(backfill.includes("migration_0059_groups"));
  assert.ok(backfill.includes("migration_0059_affected_entities"));
  assert.doesNotMatch(backfill, /\bLIKE\b|levenshtein/i);
});
