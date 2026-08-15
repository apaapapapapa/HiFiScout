import assert from "node:assert/strict";
import test from "node:test";
import {
  listManufacturerAliasEvidence,
  listUnresolvedManufacturerGroups,
  reprocessManufacturerAliasListings,
  saveManufacturerAlias,
  saveManufacturerAliasAndReprocess,
  selectListingsAffectedByManufacturerAlias,
} from "../src/db/manufacturer-repository.js";
import { captureDatabase } from "./helpers/d1.js";

test("D1 aliases load with canonical names and verification metadata", async () => {
  const db = captureDatabase([
    {
      id: 1,
      manufacturer_id: "tad",
      canonical_name: "TAD",
      alias: "Technical Audio Devices",
      normalized_alias: "technicalaudiodevices",
      verification_status: "verified",
      source: "manual_verified",
      provenance_json: '{"ticket":"DQ-1"}',
      rule_version: 2,
      created_at: "2026-08-15T00:00:00.000Z",
      updated_at: "2026-08-15T00:00:00.000Z",
    },
  ]);

  const aliases = await listManufacturerAliasEvidence(db);

  assert.deepEqual(aliases, [
    {
      manufacturerId: "tad",
      canonicalName: "TAD",
      alias: "Technical Audio Devices",
      normalizedAlias: "technicalaudiodevices",
      verificationStatus: "verified",
      source: "manual_verified",
      ruleVersion: 2,
    },
  ]);
  assert.match(db.calls[0].sql, /verification_status IN \('pending', 'verified'\)/);
});

test("manufacturer alias writes are auditable and idempotent", async () => {
  const db = captureDatabase();
  const saved = await saveManufacturerAlias(db, {
    manufacturerId: "tad",
    canonicalName: "TAD",
    alias: "Technical Audio Devices, Inc.",
    verificationStatus: "verified",
    source: "manual_verified",
    provenance: { ticket: "DQ-2" },
    updatedAt: "2026-08-15T00:00:00.000Z",
  });

  assert.equal(saved.normalizedAlias, "technicalaudiodevices");
  assert.equal(db.batched.length, 2);
  assert.match(db.batched[0].sql, /ON CONFLICT\(id\) DO UPDATE/);
  assert.match(db.batched[1].sql, /ON CONFLICT\(manufacturer_id, normalized_alias\)/);
  assert.ok(db.batched[1].binds.includes('{"ticket":"DQ-2"}'));
});

test("pending alias writes do not trigger automatic replay", async () => {
  const db = captureDatabase();
  const result = await saveManufacturerAliasAndReprocess(db, {
    manufacturerId: "example",
    canonicalName: "Example",
    alias: "Shared",
    verificationStatus: "pending",
    source: "observed_listing",
  });

  assert.equal(result.replay, null);
  assert.equal(db.batched.length, 2);
  assert.equal(db.calls.length, 2);
});

test("verified aliases select historical listings in bounded cursor order", async () => {
  const rows = [
    { id: 11, shop_key: "a", source_id: "1" },
    { id: 12, shop_key: "b", source_id: "2" },
  ];
  const db = captureDatabase(rows);
  const selected = await selectListingsAffectedByManufacturerAlias(
    db,
    { alias: "Technical Audio Devices", normalizedAlias: "technicalaudiodevices" },
    { afterId: 10, limit: 1 },
  );

  assert.equal(selected.rows.length, 1);
  assert.equal(selected.rows[0].id, 11);
  assert.equal(selected.hasMore, true);
  // Title selection uses the first brand token, because the resolver accepts any separator between
  // brand words; a literal alias LIKE would skip "Technical-Audio-Devices X-1".
  assert.deepEqual(db.calls[0].binds, [
    10,
    "technicalaudiodevices",
    "Technical Audio Devices",
    "Technical%",
    2,
  ]);
  assert.match(db.calls[0].sql, /ORDER BY id/);
  assert.match(db.calls[0].sql, /LIMIT \?/);
});

test("alias replay selects the separator spellings the resolver accepts", async () => {
  const titles = [
    "Example Audio X-1",
    "Example-Audio X-1",
    "Example_Audio X-1",
    "ExampleAudio X-1",
  ];
  const db = captureDatabase(
    titles.map((title, index) => ({ id: index + 1, shop_key: "a", source_id: `${index}` })),
  );

  await selectListingsAffectedByManufacturerAlias(db, {
    alias: "Example Audio",
    normalizedAlias: "exampleaudio",
  });

  const [, , , likePattern] = db.calls[0].binds as string[];
  const matcher = new RegExp(`^${likePattern.replace(/%$/, "")}`, "i");
  for (const title of titles) {
    assert.ok(matcher.test(title), title);
  }
});

test("verified alias replay updates only derived fields and invokes downstream refreshes", async () => {
  const aliasRow = {
    id: 1,
    manufacturer_id: "example-audio",
    canonical_name: "Example Audio",
    alias: "Example Audio Japan",
    normalized_alias: "exampleaudiojapan",
    verification_status: "verified",
    source: "manual_verified",
    provenance_json: "{}",
    rule_version: 2,
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z",
  };
  const listing = {
    id: 11,
    shop_key: "shop-a",
    source_id: "listing-11",
    manufacturer: "Example Audio Japan",
    raw_manufacturer: "Example Audio Japan",
    manufacturer_id: "exampleaudiojapan",
    canonical_manufacturer_id: "",
    manufacturer_resolution_status: "unresolved",
    manufacturer_resolution_method: "none",
    manufacturer_resolution_confidence: "none",
    manufacturer_resolver_version: 1,
    model: "Example Audio Japan X-1 中古",
    raw_model: "Example Audio Japan X-1 中古",
    normalized_model: "EXAMPLEAUDIOJAPANX1",
    model_resolution_status: "resolved",
    model_resolution_method: "legacy_normalization",
    model_resolution_confidence: "medium",
    title: "Example Audio Japan X-1",
    metadata_json: "{}",
  };
  const db = captureDatabase((statement) => {
    if (/normalized_raw_manufacturer = \?/.test(statement.sql)) return [listing];
    if (/FROM knowledge_catalog_manufacturer_aliases a/.test(statement.sql)) return [aliasRow];
    if (/SELECT id, manufacturer_id, manufacturer, raw_manufacturer/.test(statement.sql)) {
      return [
        {
          id: 11,
          manufacturer_id: "example-audio",
          manufacturer: "Example Audio",
          raw_manufacturer: "Example Audio Japan",
          model: "X-1",
          title: "Example Audio Japan X-1",
          category: "Other",
          raw_category: "Other",
          search_aliases: "",
        },
      ];
    }
    if (/SELECT id, source_id, canonical_manufacturer_id/.test(statement.sql)) {
      return [
        {
          id: 11,
          source_id: "listing-11",
          canonical_manufacturer_id: "example-audio",
          model: "X-1",
          primary_category_id: "other",
          classification_status: "unclassified",
        },
      ];
    }
    if (/SELECT id FROM products WHERE shop_key/.test(statement.sql)) return [{ id: 11 }];
    return [];
  });

  const result = await reprocessManufacturerAliasListings(
    db,
    {
      manufacturerId: "example-audio",
      canonicalName: "Example Audio",
      alias: "Example Audio Japan",
      normalizedAlias: "exampleaudiojapan",
      verificationStatus: "verified",
      source: "manual_verified",
      ruleVersion: 2,
    },
    { evaluatedAt: "2026-08-15T00:00:00.000Z" },
  );

  assert.equal(result.processedCount, 1);
  assert.equal(result.changedCount, 1);
  const update = db.batched.find((statement) => /UPDATE products SET/.test(statement.sql));
  assert.ok(update);
  assert.match(update.sql, /canonical_manufacturer_id = \?/);
  assert.doesNotMatch(update.sql, /\braw_manufacturer\s*=\s*\?/);
  // Model Resolution depends on the manufacturer this replay just corrected, so it re-runs in the
  // same page: the now-verified brand token becomes removable and the annotation is dropped.
  assert.match(update.sql, /model_resolver_version = \?/);
  assert.ok(update.binds.includes("X-1"));
  assert.ok(update.binds.includes("X1"));

  // Alias-driven corrections are auditable too, for both fields that moved.
  const events = db.batched.filter((statement) =>
    /INSERT INTO data_quality_remediation_events/.test(statement.sql),
  );
  assert.equal(events.length, 2);
  assert.ok(events[0].binds.includes("manufacturer"));
  assert.ok(events[0].binds.includes("example-audio (resolved)"));
  assert.ok(events[0].binds.includes("verified_manufacturer_alias:exampleaudiojapan"));
  assert.ok(events[1].binds.includes("model"));
  assert.ok(db.calls.some((call) => /product_search_projection/.test(call.sql)));
  assert.ok(db.calls.some((call) => /canonical_manufacturer_id/.test(call.sql)));
  assert.ok(db.calls.some((call) => /SELECT id FROM products/.test(call.sql)));
});

test("unknown manufacturer values aggregate by normalized raw value and impact", async () => {
  const db = captureDatabase([
    {
      normalized_raw_manufacturer: "example",
      sample_raw_manufacturer: "Example",
      listing_count: 12,
      shop_count: 3,
    },
  ]);
  const groups = await listUnresolvedManufacturerGroups(db, 25);

  assert.deepEqual(groups, [
    {
      normalizedRawManufacturer: "example",
      sampleRawManufacturer: "Example",
      listingCount: 12,
      shopCount: 3,
    },
  ]);
  assert.match(db.calls[0].sql, /manufacturer_resolution_status <> 'resolved'/);
  assert.match(db.calls[0].sql, /listing_count DESC, shop_count DESC/);
  assert.deepEqual(db.calls[0].binds, [25]);
});
