import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  parseAdminManufacturerQuery,
  isAdminManufacturerPage,
} from "../src/api/admin-manufacturer-contracts.js";
import { canonicalAdminPresentationColor } from "../src/api/admin-listing-contracts.js";
import { parseListingAdminUpdate } from "../src/http/listing-admin.js";
import {
  PRESENTATION_COLORS,
  presentationColorLabel,
} from "../src/catalog/model-presentation-color.js";
import { listAdminManufacturers } from "../src/db/admin-manufacturer-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

test("manufacturer queries are bounded and malformed pages cannot become selectable choices", () => {
  const parse = (query: string) =>
    parseAdminManufacturerQuery(new URL(`https://admin.test/api/admin/manufacturers?${query}`));
  assert.deepEqual(parse("q=ＬＵＸＭＡＮ&limit=2&afterId=accuphase"), {
    query: "LUXMAN",
    limit: 2,
    afterId: "accuphase",
  });
  for (const query of [
    "limit=0",
    "limit=51",
    "limit=1.5",
    "limit=1e1",
    "q=x&q=y",
    "afterId=a%00",
    "q=%00",
    "q=" + "x".repeat(101),
    "unexpected=1",
  ])
    assert.equal(parse(query), null, query);
  assert.equal(
    isAdminManufacturerPage({
      items: [{ id: "luxman", name: "LUXMAN" }],
      hasMore: true,
      nextAfterId: "luxman",
    }),
    true,
  );
  assert.equal(
    isAdminManufacturerPage({ items: [{ id: "luxman" }], hasMore: false, nextAfterId: null }),
    false,
  );
  assert.equal(
    isAdminManufacturerPage({ items: [], hasMore: true, nextAfterId: "missing" }),
    false,
  );
});

test("verified manufacturer search pages unique IDs and never promotes unverified aliases or names", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    for (const [id, name, status] of [
      ["zz-picker-a", "Picker Audio", "verified"],
      ["zz-picker-b", "Picker Sound", "verified"],
      ["zz-picker-c", "Picker Pending", "pending"],
      ["zz-picker-d", "Picker Rejected", "rejected"],
    ]) {
      sqlite
        .prepare(
          "INSERT INTO knowledge_catalog_manufacturers(id, canonical_name, verification_status, created_at, updated_at) VALUES (?, ?, ?, '2026-09-07', '2026-09-07')",
        )
        .run(id, name, status);
    }
    for (const [id, alias, status] of [
      ["zz-picker-a", "ピッカー", "verified"],
      ["zz-picker-a", "ピッカー音響", "verified"],
      ["zz-picker-b", "ピッカー未検証", "pending"],
      ["zz-picker-c", "ピッカー", "verified"],
    ]) {
      sqlite
        .prepare(
          "INSERT INTO knowledge_catalog_manufacturer_aliases(manufacturer_id, alias, normalized_alias, verification_status, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-09-07', '2026-09-07')",
        )
        .run(id, alias, alias, status);
    }
    const before = sqlite.prepare("SELECT total_changes() AS n").get()!.n;
    const first = await listAdminManufacturers(db, { query: "picker", afterId: "", limit: 1 });
    assert.deepEqual(first, {
      items: [{ id: "zz-picker-a", name: "Picker Audio" }],
      hasMore: true,
      nextAfterId: "zz-picker-a",
    });
    const second = await listAdminManufacturers(db, {
      query: "picker",
      afterId: first.nextAfterId!,
      limit: 1,
    });
    assert.deepEqual(second, {
      items: [{ id: "zz-picker-b", name: "Picker Sound" }],
      hasMore: false,
      nextAfterId: null,
    });
    const alias = await listAdminManufacturers(db, { query: "ピッカー", afterId: "", limit: 50 });
    assert.deepEqual(alias.items, [{ id: "zz-picker-a", name: "Picker Audio" }]);
    assert.deepEqual(
      (await listAdminManufacturers(db, { query: "%", afterId: "zz-picker", limit: 50 })).items,
      [],
    );
    assert.equal(
      sqlite.prepare("SELECT total_changes() AS n").get()!.n,
      before,
      "search performs no writes",
    );
  } finally {
    sqlite.close();
  }
});

test("edit preview and saved colors share canonical spelling, including explicit empty override", () => {
  for (const [input, expected] of [
    ["silver", "シルバー"],
    ["black/gold", "ブラック/ゴールド"],
    ["", ""],
  ]) {
    assert.equal(canonicalAdminPresentationColor(input, PRESENTATION_COLORS), expected);
    assert.equal(
      parseListingAdminUpdate({ presentationColor: input })?.presentationColor,
      expected,
    );
  }
  assert.equal(canonicalAdminPresentationColor("unknown-color", PRESENTATION_COLORS), null);
  assert.equal(parseListingAdminUpdate({ presentationColor: "black/unknown-color" }), null);
  for (const color of PRESENTATION_COLORS) {
    for (const spelling of [color.id, color.name, ...color.aliases, ...color.codes]) {
      assert.equal(
        canonicalAdminPresentationColor(spelling, PRESENTATION_COLORS),
        presentationColorLabel([spelling]),
      );
    }
  }
});
