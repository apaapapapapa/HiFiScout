import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { MANUFACTURER_RESOLVER_VERSION } from "../src/catalog/manufacturer-resolver.js";
import { normalizeManufacturerKey } from "../src/catalog/manufacturers.js";
import { MODEL_RESOLVER_VERSION } from "../src/catalog/model-resolver.js";
import {
  listManufacturerAliasEvidence,
  listUnresolvedManufacturerGroups,
  reprocessManufacturerAliasListings,
  reprocessStaleManufacturerListings,
  saveManufacturerAlias,
  saveManufacturerAliasAndReprocess,
  selectListingsAffectedByManufacturerAlias,
  selectStaleManufacturerListings,
} from "../src/db/manufacturer-repository.js";
import { captureDatabase, type CapturedStatement } from "./helpers/d1.js";

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
    model: "Example Audio Japan X-1 ブラック 中古",
    raw_model: "Example Audio Japan X-1 ブラック 中古",
    normalized_model: "EXAMPLEAUDIOJAPANX1",
    presentation_color: "",
    model_resolution_status: "resolved",
    model_resolution_method: "legacy_normalization",
    model_resolution_confidence: "medium",
    model_resolver_version: 1,
    remediation_projection_required: 0,
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
  assert.doesNotMatch(update.sql, /\braw_model\s*=\s*\?/);
  // Model Resolution depends on the manufacturer this replay just corrected, so it re-runs in the
  // same page: the now-verified brand token becomes removable and the annotation is dropped.
  assert.match(update.sql, /model_resolver_version = \?/);
  assert.ok(update.binds.includes("X-1"));
  assert.ok(update.binds.includes("X1"));
  assert.ok(update.binds.includes("ブラック"));
  const modelMetadata = JSON.parse(String(update.binds[17])) as {
    presentationColors?: string[];
  };
  assert.deepEqual(modelMetadata.presentationColors, ["ブラック"]);

  // Alias-driven corrections are auditable too, for both fields that moved.
  const events = db.batched.filter((statement) =>
    /INSERT INTO data_quality_remediation_events/.test(statement.sql),
  );
  assert.equal(events.length, 2);
  assert.ok(events[0].binds.includes("manufacturer"));
  assert.ok(events[0].binds.includes("example-audio (resolved)"));
  assert.ok(events[0].binds.includes("verified_manufacturer_alias:exampleaudiojapan"));
  assert.ok(events[1].binds.includes("model"));
  assert.ok(events[1].binds.includes("X-1 (X1/ブラック/resolved)"));
  assert.ok(db.calls.some((call) => /product_search_projection/.test(call.sql)));
  assert.ok(db.calls.some((call) => /canonical_manufacturer_id/.test(call.sql)));
  assert.ok(db.calls.some((call) => /SELECT id FROM products/.test(call.sql)));
});

test("stale manufacturer selection is bounded, resumable, and includes failed projections", async () => {
  const db = captureDatabase([{ id: 11 }, { id: 12 }]);

  const selected = await selectStaleManufacturerListings(db, { afterId: 10, limit: 1 });

  assert.equal(selected.rows.length, 1);
  assert.equal(selected.hasMore, true);
  assert.deepEqual(db.calls[0].binds, [10, MANUFACTURER_RESOLVER_VERSION, 2]);
  assert.match(db.calls[0].sql, /manufacturer_resolver_version < \?/);
  assert.match(db.calls[0].sql, /remediation_projection_required = 1/);
  assert.match(db.calls[0].sql, /ORDER BY id/);
});

test("runtime manufacturer replay replaces migration approximations with authoritative keys", async () => {
  const rawManufacturers = [
    "Example Audio Co., Ltd.",
    "株式会社 Example Audio",
    "Ｅｘａｍｐｌｅ　Ａｕｄｉｏ",
    "Example/Audio",
  ];
  const aliasRow = {
    id: 1,
    manufacturer_id: "example-audio",
    canonical_name: "Example Audio",
    alias: "Example Audio",
    normalized_alias: "exampleaudio",
    verification_status: "verified",
    source: "manual_verified",
    provenance_json: "{}",
    rule_version: MANUFACTURER_RESOLVER_VERSION,
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z",
  };
  const rows = rawManufacturers.map((rawManufacturer, index) => ({
    id: index + 1,
    shop_key: "shop-a",
    source_id: `listing-${index + 1}`,
    manufacturer: rawManufacturer,
    raw_manufacturer: rawManufacturer,
    manufacturer_id: "exampleaudio",
    canonical_manufacturer_id: "",
    manufacturer_resolution_status: "unresolved",
    manufacturer_resolution_method: "none",
    manufacturer_resolution_confidence: "none",
    manufacturer_resolver_version: 1,
    model: "X-1",
    raw_model: "X-1",
    normalized_model: "X1",
    presentation_color: "",
    model_resolution_status: "resolved",
    model_resolution_method: "legacy_normalization",
    model_resolution_confidence: "medium",
    model_resolver_version: 1,
    remediation_projection_required: 0,
    title: `${rawManufacturer} X-1`,
    metadata_json: "{}",
  }));
  const db = captureDatabase((statement) => {
    if (/manufacturer_resolver_version < \?/.test(statement.sql)) return rows;
    if (/FROM knowledge_catalog_manufacturer_aliases a/.test(statement.sql)) return [aliasRow];
    return [];
  });

  const replay = await reprocessStaleManufacturerListings(
    db,
    { evaluatedAt: "2026-08-15T00:00:00.000Z", limit: 10 },
    { refreshListings: async () => undefined },
  );

  assert.equal(replay.processedCount, rawManufacturers.length);
  const updates = db.batched.filter((statement) =>
    /remediation_projection_required = 1/.test(statement.sql),
  );
  assert.equal(updates.length, rawManufacturers.length);
  assert.deepEqual(
    updates.map((statement) => statement.binds[2]),
    rawManufacturers.map(normalizeManufacturerKey),
  );
});

test("manufacturer replay recovers after downstream failure without rewriting seller evidence", async () => {
  const aliasRow = {
    id: 1,
    manufacturer_id: "example-audio",
    canonical_name: "Example Audio",
    alias: "Example Audio Japan",
    normalized_alias: "exampleaudiojapan",
    verification_status: "verified",
    source: "manual_verified",
    provenance_json: "{}",
    rule_version: MANUFACTURER_RESOLVER_VERSION,
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z",
  };
  const state = {
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
    presentation_color: "",
    model_resolution_status: "resolved",
    model_resolution_method: "legacy_normalization",
    model_resolution_confidence: "medium",
    model_resolver_version: 1,
    remediation_projection_required: 0,
    title: "Example Audio Japan X-1",
    metadata_json: "{}",
  };
  let refreshAttempts = 0;
  let projection = "old";
  const db = captureDatabase((statement) => {
    if (/normalized_raw_manufacturer = \?/.test(statement.sql)) return [state];
    if (/FROM knowledge_catalog_manufacturer_aliases a/.test(statement.sql)) return [aliasRow];
    return [];
  });
  const originalBatch = db.batch.bind(db);
  Object.assign(db, {
    async batch(statements: D1PreparedStatement[]) {
      for (const statement of statements as unknown as CapturedStatement[]) {
        if (/remediation_projection_required = 1/.test(statement.sql)) {
          state.manufacturer = String(statement.binds[0]);
          state.manufacturer_id = String(statement.binds[1]);
          state.canonical_manufacturer_id = String(statement.binds[3]);
          state.manufacturer_resolution_status = String(statement.binds[4]);
          state.manufacturer_resolution_method = String(statement.binds[5]);
          state.manufacturer_resolution_confidence = String(statement.binds[6]);
          state.manufacturer_resolver_version = Number(statement.binds[7]);
          state.model = String(statement.binds[8]);
          state.normalized_model = String(statement.binds[9]);
          state.presentation_color = String(statement.binds[10]);
          state.model_resolution_status = String(statement.binds[11]);
          state.model_resolution_method = String(statement.binds[12]);
          state.model_resolution_confidence = String(statement.binds[13]);
          state.model_resolver_version = Number(statement.binds[14]);
          state.remediation_projection_required = 1;
        }
        if (/SET remediation_projection_required = 0/.test(statement.sql)) {
          state.remediation_projection_required = 0;
        }
      }
      return originalBatch(statements);
    },
  });
  const refreshListings = async (): Promise<void> => {
    refreshAttempts += 1;
    if (refreshAttempts === 1) throw new Error("injected_projection_failure");
    projection = "current";
  };
  const alias = {
    manufacturerId: "example-audio",
    canonicalName: "Example Audio",
    alias: "Example Audio Japan",
    normalizedAlias: "exampleaudiojapan",
    verificationStatus: "verified" as const,
    source: "manual_verified",
    ruleVersion: MANUFACTURER_RESOLVER_VERSION,
  };

  await assert.rejects(
    reprocessManufacturerAliasListings(
      db,
      alias,
      { evaluatedAt: "2026-08-15T00:00:00.000Z" },
      { refreshListings },
    ),
    /injected_projection_failure/,
  );
  assert.equal(state.remediation_projection_required, 1);
  assert.equal(state.raw_manufacturer, "Example Audio Japan");
  assert.equal(state.raw_model, "Example Audio Japan X-1 中古");

  const retried = await reprocessManufacturerAliasListings(
    db,
    alias,
    { evaluatedAt: "2026-08-15T00:01:00.000Z" },
    { refreshListings },
  );

  assert.equal(retried.processedCount, 1);
  assert.equal(retried.changedCount, 0);
  assert.equal(refreshAttempts, 2);
  assert.equal(projection, "current");
  assert.equal(state.remediation_projection_required, 0);
  assert.equal(state.raw_manufacturer, "Example Audio Japan");
  assert.equal(state.raw_model, "Example Audio Japan X-1 中古");
  assert.equal(state.manufacturer_resolver_version, MANUFACTURER_RESOLVER_VERSION);
  assert.equal(state.model_resolver_version, MODEL_RESOLVER_VERSION);
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
