import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { runHealthScript } from "./helpers/health-cli.js";

const baseline = [
  {
    shop_key: "audiounion",
    total_items: 1,
    in_stock_count: 1,
    latest_seen_at: "2026-09-12",
    manufacturer_missing_count: 0,
    manufacturer_unresolved_count: 0,
    category_unclassified_count: 0,
    identity_matched_count: 1,
    identity_unresolved_count: 0,
    identity_resolution_missing_count: 0,
    identity_veto_count: 0,
    identity_candidate_count: 0,
    inventory_known_count: 1,
    inventory_unknown_count: 0,
    model_expected_count: 1,
    model_extracted_count: 1,
    stale_manufacturer_listings: 0,
    stale_model_listings: 0,
  },
];
const clean = [
  {
    entity_ids: "[]",
    listing_ids: "[]",
    unmembered_active_listings: 0,
    inactive_offer_memberships: 0,
    entities_without_offers: 0,
    stale_fallback_entities: 0,
    ineligible_catalog_entities: 0,
    offer_count_mismatches: 0,
  },
];
const dataScript = "scripts/production-operational-health.sh";
const groupingScript = "scripts/product-search-identity-health.sh";
const convergenceScript = "scripts/wait-for-active-crawl-convergence.sh";

test("strict operational health keeps all gates with four queries and optional diagnostics", () => {
  const core = [baseline, clean, [], []];
  const result = runHealthScript(dataScript, core);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.labels, [
    "data_platform.baseline",
    "data_platform.search_entities",
    "data_platform.quality_runs",
    "data_platform.fts_integrity",
  ]);
  assert.match(result.sql.at(-1)!, /integrity-check/);
  const detailed = runHealthScript(
    dataScript,
    [...core, ...Array.from({ length: 7 }, () => [])],
    { HEALTH_INCLUDE_DIAGNOSTICS: "1" },
  );
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.equal(detailed.sql.length, 11);
  assert.ok(detailed.labels.includes("data_platform.unresolved_manufacturer_models"));
  const invalid = runHealthScript(dataScript, [], { HEALTH_INCLUDE_DIAGNOSTICS: "invalid" });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.sql.length, 0);
});

test("inventory and identity coverage errors still fail before FTS checking", () => {
  const inventory = runHealthScript(dataScript, [[{ ...baseline[0], in_stock_count: 0 }]]);
  assert.equal(inventory.status, 1);
  assert.match(inventory.stderr, /no active in-stock/);
  const identity = runHealthScript(dataScript, [
    [{ ...baseline[0], identity_resolution_missing_count: 1 }],
    clean,
    [],
  ]);
  assert.equal(identity.status, 1);
  assert.match(identity.stderr, /coverage gap detected/);
  assert.ok(!identity.labels.includes("data_platform.fts_integrity"));
});

test("all six projection faults fail after scoped retries; oversized scopes never retry", () => {
  for (const kind of [
    "unmembered_active_listings",
    "inactive_offer_memberships",
    "entities_without_offers",
    "stale_fallback_entities",
    "ineligible_catalog_entities",
    "offer_count_mismatches",
  ]) {
    const fault = [{ ...clean[0], [kind]: 1, entity_ids: "[1]", listing_ids: "[1]" }];
    const result = runHealthScript(dataScript, [baseline, fault, fault, fault, fault, fault, []]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.labels.filter((label) => label === "data_platform.search_entities").length, 1);
    assert.equal(
      result.labels.filter((label) => label === "data_platform.search_entities_recheck").length,
      4,
    );
  }
  const oversized = [
    {
      ...clean[0],
      entity_ids: JSON.stringify(Array.from({ length: 1001 }, (_, i) => i + 1)),
    },
  ];
  const result = runHealthScript(dataScript, [baseline, oversized]);
  assert.equal(result.status, 1);
  assert.equal(result.sql.length, 2);
});

test("split grouping observes the catalog once and rechecks safely quoted captured identities", () => {
  const split = [
    {
      canonical_manufacturer_id: "maker's",
      normalized_model: "X'2 $() `x`",
      listing_count: 2,
    },
  ];
  const result = runHealthScript(groupingScript, [split, []]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.labels, [
    "product_search.split_groups",
    "product_search.split_groups_recheck",
  ]);
  assert.match(result.sql[1], /json_each\('\[\["maker''s","X''2 \$\(\) `x`"\]\]'\)/);
  assert.match(result.sql[1], /json_extract\(observed.value, '\$\[0\]'\)/);
  const persistent = runHealthScript(groupingScript, [split, split]);
  assert.equal(persistent.status, 1);
  const oversized = runHealthScript(groupingScript, [
    Array.from({ length: 51 }, (_, i) => ({
      canonical_manufacturer_id: "maker",
      normalized_model: String(i),
    })),
  ]);
  assert.equal(oversized.status, 1);
  assert.equal(oversized.sql.length, 1);
  const detailed = runHealthScript(groupingScript, [[], [], []], { HEALTH_INCLUDE_DIAGNOSTICS: "1" });
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.equal(detailed.sql.length, 3);
});

test("convergence polls only observed gaps and terminates at the existing time bound", () => {
  const healthy = runHealthScript(convergenceScript, [[]]);
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.deepEqual(healthy.labels, ["convergence.identity_gaps"]);
  const gap = [{ id: 7 }];
  const active = [{ shop_key: "shop", active_session_count: 1 }];
  const repaired = runHealthScript(convergenceScript, [gap, active, [], []]);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.deepEqual(repaired.labels, [
    "convergence.identity_gaps",
    "convergence.blocking_sessions",
    "convergence.blocking_sessions",
    "convergence.identity_gaps_recheck",
  ]);
  assert.match(repaired.sql[1], /json_each\('\[7\]'\)/);
  assert.match(repaired.sql[3], /p\.id IN \(SELECT value FROM json_each\('\[7\]'\)\)/);
  const persistent = runHealthScript(convergenceScript, [gap, active, active], {
    ACTIVE_CRAWL_CONVERGENCE_MAX_WAIT_SECONDS: "15",
  });
  assert.equal(persistent.status, 0, persistent.stderr);
  assert.match(persistent.stderr, /continuing to the strict health checks/);
  assert.equal(persistent.sql.length, 3);
});
