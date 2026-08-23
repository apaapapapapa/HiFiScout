import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildKnowledgeCatalogCandidateAggregates,
  candidatePriority,
} from "../src/catalog/knowledge-catalog.js";
import {
  listUnresolvedIdentityGroups,
  loadCatalogRemediationTarget,
  reprocessPendingCatalogRemediation,
  reprocessVerifiedCatalogProduct,
  selectListingsForCatalogRemediation,
} from "../src/db/knowledge-catalog-remediation-repository.js";
import type { KnowledgeCatalogListingRow } from "../src/catalog/types.js";
import { captureDatabase } from "./helpers/d1.js";

function listing(overrides: Partial<KnowledgeCatalogListingRow> = {}): KnowledgeCatalogListingRow {
  return {
    shop_key: "hifido",
    manufacturer_id: "esoteric",
    manufacturer: "ESOTERIC",
    model: "K-01XD",
    raw_model: "K-01XD",
    title: "ESOTERIC K-01XD",
    source_url: "https://example.test/1",
    category_ids: '["cd_sacd_player"]',
    classification_status: "classified",
    identity_status: "unresolved",
    identity_match_method: "unresolved",
    first_seen_at: "2026-08-01T00:00:00.000Z",
    last_seen_at: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

test("unresolved groups aggregate deterministically with reviewable evidence", () => {
  const [candidate] = buildKnowledgeCatalogCandidateAggregates([
    listing(),
    listing({
      shop_key: "fujiya-avic",
      raw_model: "K-01XD 中古",
      source_url: "https://example.test/2",
      classification_status: "unclassified",
      category_ids: "[]",
      last_seen_at: "2026-08-12T00:00:00.000Z",
    }),
  ]);

  assert.equal(candidate.listingCount, 2);
  assert.equal(candidate.shopCount, 2);
  assert.equal(candidate.unclassifiedCount, 1);
  assert.equal(candidate.unresolvedIdentityCount, 2);
  assert.deepEqual(candidate.rawModelVariants, ["K-01XD", "K-01XD 中古"]);
  assert.deepEqual(candidate.sourceUrls, ["https://example.test/1", "https://example.test/2"]);
  assert.equal(candidate.identityRejectionReason, "unresolved");
  assert.equal(candidate.firstSeenAt, "2026-08-01T00:00:00.000Z");
  assert.equal(candidate.lastSeenAt, "2026-08-12T00:00:00.000Z");
});

test("aggregation is idempotent for the same listing evidence", () => {
  const rows = [listing(), listing({ shop_key: "fujiya-avic" })];

  assert.deepEqual(
    buildKnowledgeCatalogCandidateAggregates(rows),
    buildKnowledgeCatalogCandidateAggregates(rows),
  );
});

test("candidate evidence never regenerates an empty raw model from the derived model", () => {
  const [candidate] = buildKnowledgeCatalogCandidateAggregates([
    listing({ raw_model: "", model: "E-800", title: "Accuphase E-800" }),
  ]);

  assert.deepEqual(candidate.rawModelVariants, []);
});

test("a matched listing is not counted as unresolved identity work", () => {
  const [candidate] = buildKnowledgeCatalogCandidateAggregates([
    listing({ identity_status: "matched", identity_match_method: "manufacturer_model_exact" }),
  ]);

  assert.equal(candidate.unresolvedIdentityCount, 0);
  assert.equal(candidate.identityRejectionReason, "");
});

test("a listing with no resolution row is still unresolved work", () => {
  const [candidate] = buildKnowledgeCatalogCandidateAggregates([
    listing({ identity_status: undefined, identity_match_method: undefined }),
  ]);

  assert.equal(candidate.unresolvedIdentityCount, 1);
  assert.equal(candidate.identityRejectionReason, "missing_resolution");
});

test("priority ranks broad unresolved impact above a one-off unknown item", () => {
  const [broad, oneOff] = buildKnowledgeCatalogCandidateAggregates([
    listing({ model: "K-01XD", classification_status: "unclassified", category_ids: "[]" }),
    listing({
      model: "K-01XD",
      shop_key: "fujiya-avic",
      classification_status: "unclassified",
      category_ids: "[]",
    }),
    listing({ model: "ONE-OFF-1" }),
  ]);

  assert.equal(broad.normalizedModel, "K-01XD");
  assert.equal(oneOff.normalizedModel, "ONE-OFF-1");
  assert.ok(broad.priorityScore > oneOff.priorityScore);
  assert.equal(broad.priorityScore, candidatePriority(broad));
  // Cross-shop repetition contributes, but it is not on its own proof of product identity.
  assert.ok(candidatePriority({ shopCount: 5 }) < candidatePriority({ unclassifiedCount: 1 }));
});

test("priority is a pure function of the aggregate, not of how it was accumulated", () => {
  const rows = [
    listing({ manufacturer_id: "esoteric", model: "K-01XD" }),
    listing({ manufacturer_id: "luxman", model: "L-507Z", shop_key: "fujiya-avic" }),
    listing({ manufacturer_id: "accuphase", model: "E-800", shop_key: "ippinkan" }),
  ];

  for (const candidate of buildKnowledgeCatalogCandidateAggregates(rows)) {
    assert.equal(candidate.priorityScore, candidatePriority(candidate));
  }
});

test("candidates that score identically are ordered by identity, not by arrival", () => {
  // Three one-listing groups with nothing to separate them but their keys. Without an explicit
  // tie-break the order would follow accumulation order, and a reviewer's queue would reshuffle on
  // every sweep for no reason — which is exactly what makes a "top unresolved products" list
  // untrustworthy.
  const rows = [
    listing({ manufacturer_id: "luxman", model: "L-507Z", source_url: "https://example.test/l" }),
    listing({ manufacturer_id: "accuphase", model: "E-800", source_url: "https://example.test/a" }),
    listing({ manufacturer_id: "esoteric", model: "K-01XD", source_url: "https://example.test/e" }),
  ];

  const forward = buildKnowledgeCatalogCandidateAggregates(rows);
  const reversed = buildKnowledgeCatalogCandidateAggregates([...rows].reverse());

  assert.deepEqual(
    forward.map((candidate) => candidate.manufacturerId),
    ["accuphase", "esoteric", "luxman"],
  );
  assert.deepEqual(forward, reversed);
});

test("unresolved identity groups are keyed by canonical manufacturer and normalized model", async () => {
  const db = captureDatabase([
    {
      canonical_manufacturer_id: "esoteric",
      normalized_model: "K01XD",
      sample_model: "K-01XD",
      sample_raw_model: "K-01XD 中古",
      sample_source_url: "https://example.test/1",
      identity_rejection_reason: "unresolved",
      listing_count: 9,
      shop_count: 3,
      unclassified_count: 2,
      first_seen_at: "2026-08-01T00:00:00.000Z",
      last_seen_at: "2026-08-12T00:00:00.000Z",
    },
  ]);

  const groups = await listUnresolvedIdentityGroups(db, 25);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].canonicalManufacturerId, "esoteric");
  assert.equal(groups[0].normalizedModel, "K01XD");
  assert.equal(groups[0].identityRejectionReason, "unresolved");
  assert.equal(groups[0].listingCount, 9);
  assert.match(db.calls[0].sql, /GROUP BY p\.canonical_manufacturer_id, p\.normalized_model/);
  assert.match(db.calls[0].sql, /COALESCE\(r\.status, 'unresolved'\) <> 'matched'/);
  assert.deepEqual(db.calls[0].binds, [25]);
});

test("a verified catalog entry targets listings through the identity normalization", async () => {
  const db = captureDatabase((statement) => {
    if (/FROM knowledge_catalog_products/.test(statement.sql)) {
      return [{ id: 7, manufacturer_id: "esoteric", canonical_model: "K-01XD" }];
    }
    if (/FROM knowledge_catalog_aliases/.test(statement.sql)) return [{ alias: "K01 XD" }];
    return [];
  });

  const target = await loadCatalogRemediationTarget(db, 7);

  assert.ok(target);
  assert.equal(target.manufacturerId, "esoteric");
  assert.deepEqual(target.identityModels, ["K01XD"]);
  assert.match(db.calls[0].sql, /verification_status = 'verified'/);
});

test("an unverified catalog entry cannot drive a replay", async () => {
  const db = captureDatabase([]);

  const result = await reprocessVerifiedCatalogProduct(db, 7);

  assert.equal(result.target, null);
  assert.equal(result.replay, null);
});

test("catalog replay selects listings in bounded cursor order", async () => {
  const db = captureDatabase([
    { id: 11, shop_key: "hifido", source_id: "a" },
    { id: 12, shop_key: "fujiya-avic", source_id: "b" },
  ]);

  const selected = await selectListingsForCatalogRemediation(
    db,
    {
      catalogProductId: 7,
      manufacturerId: "esoteric",
      canonicalModel: "K-01XD",
      identityModels: ["K01XD"],
    },
    { afterId: 10, limit: 1 },
  );

  assert.equal(selected.rows.length, 1);
  assert.equal(selected.hasMore, true);
  assert.deepEqual(db.calls[0].binds, [10, "esoteric", "K01XD", 2]);
  assert.match(db.calls[0].sql, /ORDER BY id/);
});

test("catalog replay records the identity transition it caused", async () => {
  let identityReads = 0;
  const db = captureDatabase((statement) => {
    if (/FROM knowledge_catalog_products/.test(statement.sql)) {
      return [{ id: 7, manufacturer_id: "esoteric", canonical_model: "K-01XD" }];
    }
    if (/FROM knowledge_catalog_aliases/.test(statement.sql)) return [];
    if (/normalized_model IN \(/.test(statement.sql)) {
      return [{ id: 11, shop_key: "hifido", source_id: "listing-11" }];
    }
    if (/SELECT listing_product_id, catalog_product_id, status, match_method/.test(statement.sql)) {
      identityReads += 1;
      return identityReads === 1
        ? [
            {
              listing_product_id: 11,
              catalog_product_id: null,
              status: "unresolved",
              match_method: "unresolved",
            },
          ]
        : [
            {
              listing_product_id: 11,
              catalog_product_id: 7,
              status: "matched",
              match_method: "manufacturer_model_exact",
            },
          ];
    }
    if (/SELECT id, manufacturer_id, manufacturer, raw_manufacturer/.test(statement.sql)) {
      return [
        {
          id: 11,
          manufacturer_id: "esoteric",
          manufacturer: "ESOTERIC",
          raw_manufacturer: "ESOTERIC",
          model: "K-01XD",
          title: "ESOTERIC K-01XD",
          category: "CD/SACD player",
          raw_category: "CD/SACD player",
          search_aliases: "",
        },
      ];
    }
    if (/SELECT id FROM products WHERE shop_key/.test(statement.sql)) return [{ id: 11 }];
    return [];
  });

  const { replay } = await reprocessVerifiedCatalogProduct(db, 7, {
    evaluatedAt: "2026-08-15T00:00:00.000Z",
  });

  assert.ok(replay);
  assert.equal(replay.processedCount, 1);
  assert.equal(replay.changedCount, 1);
  assert.equal(replay.matchedCount, 1);
  const event = db.batched.find((statement) =>
    /INSERT INTO data_quality_remediation_events/.test(statement.sql),
  );
  assert.ok(event);
  assert.ok(event.binds.includes("identity"));
  assert.ok(event.binds.includes("unresolved:unresolved:-"));
  assert.ok(event.binds.includes("matched:manufacturer_model_exact:7"));
  assert.ok(event.binds.includes("verified_catalog_product:7"));
});

test("a replay that changes no identity writes no provenance", async () => {
  const state = {
    listing_product_id: 11,
    catalog_product_id: null,
    status: "unresolved",
    match_method: "unresolved",
  };
  const db = captureDatabase((statement) => {
    if (/FROM knowledge_catalog_products/.test(statement.sql)) {
      return [{ id: 7, manufacturer_id: "esoteric", canonical_model: "K-01XD" }];
    }
    if (/normalized_model IN \(/.test(statement.sql)) {
      return [{ id: 11, shop_key: "hifido", source_id: "listing-11" }];
    }
    if (/SELECT listing_product_id, catalog_product_id, status, match_method/.test(statement.sql)) {
      return [state];
    }
    return [];
  });

  const { replay } = await reprocessVerifiedCatalogProduct(db, 7, {
    evaluatedAt: "2026-08-15T00:00:00.000Z",
  });

  assert.equal(replay?.changedCount, 0);
  assert.ok(
    !db.batched.some((statement) =>
      /INSERT INTO data_quality_remediation_events/.test(statement.sql),
    ),
  );
});

const VERIFIED_AT = "2026-08-14T00:00:00.000Z";

function pendingSweepDatabase(
  listings: { id: number; shop_key: string; source_id: string }[],
  remediationAfterListingId = 0,
) {
  return captureDatabase((statement) => {
    if (/COUNT\(\*\) AS pending/.test(statement.sql)) return [{ pending: 3 }];
    if (/last_remediated_at IS NULL OR last_remediated_at < last_verified_at/.test(statement.sql)) {
      return [
        {
          id: 7,
          last_verified_at: VERIFIED_AT,
          remediation_after_listing_id: remediationAfterListingId,
        },
      ];
    }
    if (/FROM knowledge_catalog_products/.test(statement.sql)) {
      return [{ id: 7, manufacturer_id: "esoteric", canonical_model: "K-01XD" }];
    }
    if (/normalized_model IN \(/.test(statement.sql)) return listings;
    return [];
  });
}

test("the sweep selects a durable backlog rather than a time window", async () => {
  const db = pendingSweepDatabase([{ id: 11, shop_key: "hifido", source_id: "a" }]);

  const summary = await reprocessPendingCatalogRemediation(db, {
    productLimit: 5,
    limit: 10,
    evaluatedAt: "2026-08-15T01:00:00.000Z",
  });

  assert.equal(summary.catalogProducts, 1);
  // Oldest verification first, so a backlog drains in order instead of re-doing the newest.
  assert.match(db.calls[0].sql, /ORDER BY last_verified_at, id/);
  assert.doesNotMatch(db.calls[0].sql, /last_verified_at >= \?/);
  assert.deepEqual(db.calls[0].binds, [6]);
  // A fully replayed product advances its watermark so the next run moves past it.
  const watermark = db.batched.find((statement) =>
    /UPDATE knowledge_catalog_products\s+SET last_remediated_at/.test(statement.sql),
  );
  assert.ok(watermark);
  assert.deepEqual(watermark.binds, [
    "2026-08-15T01:00:00.000Z",
    "2026-08-15T01:00:00.000Z",
    7,
    VERIFIED_AT,
  ]);
  assert.equal(summary.pendingProducts, 3);
  assert.equal(summary.hasMoreProducts, true);
  assert.equal(summary.remainingProductCount, 3);
  assert.equal(summary.incompleteProductCount, 3);
});

test("a partially replayed product keeps its watermark so the next run resumes it", async () => {
  const db = pendingSweepDatabase([
    { id: 11, shop_key: "hifido", source_id: "a" },
    { id: 12, shop_key: "hifido", source_id: "b" },
  ]);

  const summary = await reprocessPendingCatalogRemediation(db, {
    productLimit: 5,
    limit: 1,
    evaluatedAt: "2026-08-15T01:00:00.000Z",
  });

  assert.equal(summary.processedCount, 1);
  const cursor = db.batched.find((statement) =>
    /SET remediation_after_listing_id = \?/.test(statement.sql),
  );
  assert.ok(cursor);
  assert.deepEqual(cursor.binds, [11, "2026-08-15T01:00:00.000Z", 7, VERIFIED_AT]);
  // Work that did not fit is reported, never silently dropped.
  assert.equal(summary.pendingProducts, 3);

  const resumed = pendingSweepDatabase([{ id: 12, shop_key: "hifido", source_id: "b" }], 11);
  await reprocessPendingCatalogRemediation(resumed, {
    productLimit: 5,
    limit: 1,
    evaluatedAt: "2026-08-15T01:01:00.000Z",
  });
  const listingPage = resumed.calls.find((statement) =>
    /normalized_model IN \(/.test(statement.sql),
  );
  assert.ok(listingPage);
  assert.equal(listingPage.binds[0], 11);
  assert.ok(
    resumed.batched.some(
      (statement) =>
        /last_remediated_at = \?/.test(statement.sql) &&
        /remediation_after_listing_id = 0/.test(statement.sql),
    ),
  );
});

test("product-axis overflow is explicit when 21 verified products exceed a limit of 20", async () => {
  let currentProductId = 0;
  const products = Array.from({ length: 21 }, (_, index) => ({
    id: index + 1,
    last_verified_at: VERIFIED_AT,
    remediation_after_listing_id: 0,
  }));
  const db = captureDatabase((statement) => {
    if (/COUNT\(\*\) AS pending/.test(statement.sql)) return [{ pending: 1 }];
    if (/last_remediated_at IS NULL OR last_remediated_at < last_verified_at/.test(statement.sql)) {
      return products;
    }
    if (/SELECT id, manufacturer_id, canonical_model/.test(statement.sql)) {
      currentProductId = Number(statement.binds[0]);
      return [
        {
          id: currentProductId,
          manufacturer_id: "example",
          canonical_model: `X-${currentProductId}`,
        },
      ];
    }
    if (/normalized_model IN \(/.test(statement.sql)) {
      return [
        {
          id: 1000 + currentProductId,
          shop_key: "shop-a",
          source_id: `listing-${currentProductId}`,
        },
      ];
    }
    return [];
  });

  const summary = await reprocessPendingCatalogRemediation(db, {
    productLimit: 20,
    limit: 5,
    evaluatedAt: "2026-08-15T01:00:00.000Z",
  });

  assert.deepEqual(db.calls[0].binds, [21]);
  assert.equal(summary.catalogProducts, 20);
  assert.equal(summary.processedCount, 20);
  assert.equal(summary.pendingProducts, 1);
  assert.equal(summary.hasMoreProducts, true);
  assert.equal(summary.remainingProductCount, 1);
  assert.equal(summary.incompleteProductCount, 1);
});
