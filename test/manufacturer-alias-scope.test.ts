import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createManufacturerResolver } from "../src/catalog/manufacturer-resolver.js";
import { createModelResolver } from "../src/catalog/model-resolver.js";
import { listManufacturerAliasEvidence } from "../src/db/manufacturer-repository.js";
import { readAdminManufacturerAliases } from "../src/db/admin-manufacturer-registry.js";
import type { ManufacturerAliasEvidence } from "../src/catalog/types.js";
import { database } from "./helpers/d1-write-budget.js";

const alias = (overrides: Partial<ManufacturerAliasEvidence> = {}): ManufacturerAliasEvidence => ({
  manufacturerId: "luxman",
  canonicalName: "LUXMAN",
  alias: "デモラボ",
  normalizedAlias: "デモラボ",
  verificationStatus: "verified",
  source: "admin_alias_control",
  ruleVersion: 1,
  shopKey: "audiounion",
  ...overrides,
});

test("compiled manufacturer and model aliases stay within their shop, including alternating calls", () => {
  const rows = [alias()];
  const manufacturer = createManufacturerResolver(rows);
  const model = createModelResolver(rows);
  for (const shopKey of ["audiounion", "hifido", "", "audiounion"]) {
    assert.equal(
      manufacturer({ rawManufacturer: "デモラボ", shopKey }).canonicalManufacturerId,
      shopKey === "audiounion" ? "luxman" : "",
    );
    const result = model({ rawModel: "デモラボ L-505", manufacturerId: "luxman", shopKey });
    assert.equal(result.model, shopKey === "audiounion" ? "L-505" : "デモラボ L-505");
  }
});

test("explicit local rejection masks a global/bundled spelling without resolving other-brand collisions", () => {
  const rejection = alias({
    alias: "ラックスマン",
    normalizedAlias: "ラックスマン",
    verificationStatus: "rejected",
  });
  const resolver = createManufacturerResolver([rejection]);
  assert.equal(
    resolver({ rawManufacturer: "ラックスマン", shopKey: "audiounion" }).canonicalManufacturerId,
    "",
  );
  assert.equal(
    resolver({ rawManufacturer: "ラックスマン", shopKey: "hifido" }).canonicalManufacturerId,
    "luxman",
  );
  const model = createModelResolver([rejection]);
  assert.equal(
    model({ rawModel: "ラックスマン L-505", manufacturerId: "luxman", shopKey: "audiounion" })
      .model,
    "ラックスマン L-505",
  );
  const legacy = createManufacturerResolver([{ ...rejection, source: "observed_listing" }]);
  assert.equal(
    legacy({ rawManufacturer: "ラックスマン", shopKey: "audiounion" }).canonicalManufacturerId,
    "luxman",
  );
  const collision = createManufacturerResolver([
    alias(),
    alias({ shopKey: "", manufacturerId: "other", canonicalName: "Other" }),
  ]);
  assert.equal(
    collision({ rawManufacturer: "デモラボ", shopKey: "audiounion" }).method,
    "ambiguous_alias",
  );
  assert.equal(
    collision({ rawManufacturer: "デモラボ", shopKey: "hifido" }).canonicalManufacturerId,
    "other",
  );
});

test("global canonical presentation propagates to bundled spellings", () => {
  const resolver = createManufacturerResolver([
    alias({ shopKey: "", canonicalName: "Luxman Audio" }),
  ]);
  assert.equal(resolver({ rawManufacturer: "ラックスマン" }).displayName, "Luxman Audio");
});

test("both database readers retain scoped rejection and global evidence without leaking shop aliases", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(
        "INSERT INTO knowledge_catalog_manufacturers(id,canonical_name,verification_status,created_at,updated_at) VALUES('scope-test','Scope Test','verified','','')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO knowledge_catalog_manufacturer_aliases(manufacturer_id,alias,normalized_alias,verification_status,created_at,updated_at) VALUES('scope-test','Global Scope','globalscope','verified','','')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO knowledge_catalog_shop_manufacturer_aliases(manufacturer_id,alias,normalized_alias,verification_status,created_at,updated_at,shop_key) VALUES('scope-test','Global Scope','globalscope','rejected','','','audiounion')",
      )
      .run();
    for (const rows of [
      await listManufacturerAliasEvidence(db),
      await readAdminManufacturerAliases(db),
    ]) {
      const resolver = createManufacturerResolver(rows);
      assert.equal(
        resolver({ rawManufacturer: "Global Scope", shopKey: "audiounion" })
          .canonicalManufacturerId,
        "",
      );
      assert.equal(
        resolver({ rawManufacturer: "Global Scope", shopKey: "hifido" }).canonicalManufacturerId,
        "scope-test",
      );
    }
  } finally {
    await dispose();
  }
}, 30_000);

test("a preview can enable a spelling that is currently disabled only for the requested shop", async () => {
  const { previewAdminExtraction } = await import("../src/admin/extraction-preview.js");
  const { db, dispose } = await database();
  try {
    await db
      .prepare(
        "INSERT INTO knowledge_catalog_manufacturers(id,canonical_name,verification_status,created_at,updated_at) VALUES('luxman','LUXMAN','verified','','') ON CONFLICT(id) DO NOTHING",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO knowledge_catalog_shop_manufacturer_aliases(manufacturer_id,alias,normalized_alias,verification_status,created_at,updated_at,shop_key) VALUES('luxman','デモラボ','デモラボ','rejected','','','audiounion')",
      )
      .run();
    const raw = {
      title: "デモラボ L-505",
      rawManufacturer: "デモラボ",
      rawModel: "デモラボ L-505",
      rawCategory: "",
      shopKey: "audiounion",
    };
    const result = await previewAdminExtraction(db, {
      samples: [raw, { ...raw, shopKey: "hifido" }],
      draftAlias: { manufacturerId: "luxman", alias: "デモラボ", shopKey: "audiounion" },
    });
    assert.equal(result.items[0].current?.manufacturerId, "");
    assert.equal(result.items[0].proposed?.manufacturerId, "luxman");
    assert.equal(result.items[0].proposed?.model, "L-505");
    assert.equal(result.items[1].proposed?.manufacturerId, "");
  } finally {
    await dispose();
  }
}, 30_000);
