import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_LIST_COLUMNS, toProductListItem } from "../src/db/product-row-mapper.js";
import type { ProductRow } from "../src/db/types.js";

test("public listing DTO excludes raw and remediation provenance", () => {
  const row = {
    id: 7,
    shop_key: "hifido",
    source_id: "source-7",
    manufacturer: "TAD",
    model: "D1000MK2",
    title: "TAD D1000MK2",
    category: "DAC",
    condition_text: "中古",
    price_yen: 500000,
    stock_status: "in_stock",
    source_url: "https://example.test/7",
    first_seen_at: "2026-08-01T00:00:00.000Z",
    last_seen_at: "2026-08-15T00:00:00.000Z",
    last_changed_at: "2026-08-15T00:00:00.000Z",
    previous_price_yen: 550000,
    last_activity_at: "2026-08-15T00:00:00.000Z",
    source_published_at: null,
    metadata_json: '{"manufacturerNormalization":{"method":"verified_alias"}}',
    raw_manufacturer: "Technical Audio Devices",
    raw_category: "デジタル機器",
    classification_status: "classified",
    search_aliases: "TAD D1000",
    remediation_projection_required: 1,
    remediation_projection_token: "secret-internal-token",
  } as ProductRow;

  const item = toProductListItem(row);

  assert.equal(item.manufacturer, "TAD");
  assert.equal(item.title, "TAD D1000MK2");
  for (const internal of [
    "metadata_json",
    "raw_manufacturer",
    "raw_category",
    "classification_status",
    "search_aliases",
    "remediation_projection_required",
    "remediation_projection_token",
  ]) {
    assert.equal(internal in item, false, `${internal} must not be public`);
    assert.equal(PRODUCT_LIST_COLUMNS.includes(internal as never), false);
  }
});
