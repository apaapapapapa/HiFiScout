import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_RESOLVER_VERSION } from "../src/catalog/model-resolver.js";
import {
  listUnresolvedModelGroups,
  reprocessStaleModelListings,
  resolveProductCatalogFields,
  selectStaleModelListings,
} from "../src/db/model-repository.js";
import type { NormalizedCatalogProduct } from "../src/catalog/types.js";
import { captureDatabase } from "./helpers/d1.js";

function staleListing(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    shop_key: "shop-a",
    source_id: "listing-11",
    canonical_manufacturer_id: "tad",
    model: "D-1000 MK2 中古",
    raw_model: "D-1000 MK2 中古",
    normalized_model: "D1000MK2",
    model_resolution_status: "resolved",
    model_resolution_method: "legacy_normalization",
    model_resolution_confidence: "medium",
    title: "TAD D-1000 MK2 中古",
    metadata_json: "{}",
    ...overrides,
  };
}

function replayDatabase(listing: Record<string, unknown>) {
  return captureDatabase((statement) => {
    if (/model_resolver_version < \?/.test(statement.sql)) return [listing];
    if (/SELECT id, manufacturer_id, manufacturer, raw_manufacturer/.test(statement.sql)) {
      return [
        {
          id: listing.id,
          manufacturer_id: "tad",
          manufacturer: "TAD",
          raw_manufacturer: "TAD",
          model: "D-1000 MK2",
          title: "TAD D-1000 MK2",
          category: "CD/SACD player",
          raw_category: "CD/SACD player",
          search_aliases: "",
        },
      ];
    }
    if (/SELECT id, source_id, canonical_manufacturer_id/.test(statement.sql)) {
      return [
        {
          id: listing.id,
          source_id: listing.source_id,
          canonical_manufacturer_id: "tad",
          model: "D-1000 MK2",
          primary_category_id: "cd_sacd_player",
          classification_status: "classified",
        },
      ];
    }
    if (/SELECT id FROM products WHERE shop_key/.test(statement.sql)) return [{ id: listing.id }];
    return [];
  });
}

test("stale model selection is bounded and cursor-restartable", async () => {
  const db = captureDatabase([staleListing({ id: 11 }), staleListing({ id: 12 })]);

  const selected = await selectStaleModelListings(db, { afterId: 10, limit: 1 });

  assert.equal(selected.rows.length, 1);
  assert.equal(selected.hasMore, true);
  assert.deepEqual(db.calls[0].binds, [10, MODEL_RESOLVER_VERSION, 2]);
  assert.match(db.calls[0].sql, /ORDER BY id/);
  assert.match(db.calls[0].sql, /model_resolver_version < \?/);
});

test("replay rewrites only derived model fields and leaves seller facts alone", async () => {
  const db = replayDatabase(staleListing());

  const result = await reprocessStaleModelListings(db, { evaluatedAt: "2026-08-15T00:00:00.000Z" });

  assert.equal(result.processedCount, 1);
  assert.equal(result.changedCount, 1);
  const update = db.batched.find((statement) => /UPDATE products SET/.test(statement.sql));
  assert.ok(update);
  assert.match(update.sql, /model_resolver_version = \?/);
  for (const sellerFact of [
    "price_yen",
    "stock_status",
    "source_url",
    "first_seen_at",
    "last_seen_at",
  ]) {
    assert.doesNotMatch(update.sql, new RegExp(`${sellerFact}\\s*=`), sellerFact);
  }
  assert.ok(update.binds.includes("D-1000 MK2"));
  assert.ok(update.binds.includes(MODEL_RESOLVER_VERSION));
});

test("replay records before/after provenance only for listings that actually moved", async () => {
  const changed = replayDatabase(staleListing());
  await reprocessStaleModelListings(changed, { evaluatedAt: "2026-08-15T00:00:00.000Z" });
  const event = changed.batched.find((statement) =>
    /INSERT INTO data_quality_remediation_events/.test(statement.sql),
  );
  assert.ok(event);
  assert.ok(event.binds.includes("model"));
  assert.ok(event.binds.includes("model_resolver_version_replay"));

  const unchanged = replayDatabase(
    staleListing({
      model: "D-1000 MK2",
      raw_model: "D-1000 MK2",
      model_resolution_status: "resolved",
      model_resolution_method: "seller_model",
      model_resolution_confidence: "high",
      title: "TAD D-1000 MK2",
    }),
  );
  const result = await reprocessStaleModelListings(unchanged, {
    evaluatedAt: "2026-08-15T00:00:00.000Z",
  });

  assert.equal(result.processedCount, 1);
  assert.equal(result.changedCount, 0);
  assert.ok(
    !unchanged.batched.some((statement) =>
      /INSERT INTO data_quality_remediation_events/.test(statement.sql),
    ),
  );
  // The version still advances, so a second pass cannot re-select the same row forever.
  const update = unchanged.batched.find((statement) => /UPDATE products SET/.test(statement.sql));
  assert.ok(update?.binds.includes(MODEL_RESOLVER_VERSION));
});

test("replay refreshes identity and the search projection in dependency order", async () => {
  const db = replayDatabase(staleListing());

  await reprocessStaleModelListings(db, { evaluatedAt: "2026-08-15T00:00:00.000Z" });

  const projection = db.calls.findIndex((call) => /FROM product_search_projection/.test(call.sql));
  const identity = db.calls.findIndex((call) => /FROM product_identity_resolutions/.test(call.sql));
  const entity = db.calls.findIndex((call) => /product_search_entities/.test(call.sql));
  assert.ok(projection >= 0, "search projection refreshed");
  assert.ok(identity > projection, "identity resolved after the projection");
  assert.ok(entity > identity, "search entity rebuilt after identity");
});

test("catalog field resolution applies the manufacturer before the model", async () => {
  const db = captureDatabase([]);
  const product = {
    sourceId: "p1",
    manufacturer: "Accuphase",
    rawManufacturer: "Accuphase",
    manufacturerId: "",
    model: "Accuphase E-800 中古",
    rawModel: "Accuphase E-800 中古",
    normalizedModel: "",
    title: "Accuphase E-800 中古",
    metadata: {},
  } as unknown as NormalizedCatalogProduct;

  const [resolved] = await resolveProductCatalogFields(db, [product]);

  assert.equal(resolved.manufacturerId, "accuphase");
  // Only a resolved manufacturer makes its own presentation token safe to remove.
  assert.equal(resolved.model, "E-800");
  assert.equal(resolved.normalizedModel, "E800");
  assert.equal(resolved.modelResolutionStatus, "resolved");
});

test("unresolved model groups are ordered by affected listing impact", async () => {
  const db = captureDatabase([
    {
      canonical_manufacturer_id: "tad",
      normalized_model: "D1000",
      sample_raw_model: "D-1000 特価",
      model_resolution_status: "candidate",
      model_resolution_method: "unsafe_annotation",
      listing_count: 12,
      shop_count: 3,
    },
  ]);

  const groups = await listUnresolvedModelGroups(db, 10);

  assert.deepEqual(groups, [
    {
      canonicalManufacturerId: "tad",
      normalizedModel: "D1000",
      sampleRawModel: "D-1000 特価",
      resolutionStatus: "candidate",
      resolutionMethod: "unsafe_annotation",
      listingCount: 12,
      shopCount: 3,
    },
  ]);
  assert.match(db.calls[0].sql, /model_resolution_status <> 'resolved'/);
  assert.match(db.calls[0].sql, /ORDER BY listing_count DESC, shop_count DESC/);
  assert.deepEqual(db.calls[0].binds, [10]);
});
