import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { isRecord } from "../src/types.js";

const sourceId = `fts-integration-${process.pid}`;
const now = "2026-08-12T00:00:00.000Z";

function d1(command: string): unknown {
  const output = execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", command],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

try {
  d1(`
    INSERT INTO products(
      shop_key, source_id, manufacturer, model, title, category, condition_text,
      price_yen, stock_status, source_url, first_seen_at, last_seen_at, last_changed_at, is_active,
      raw_manufacturer, manufacturer_id, raw_category, primary_category_id, category_ids,
      classification_status, search_aliases, last_activity_at
    ) VALUES (
      'integration', '${sourceId}', 'TAD', 'D1000MK2', 'TAD D1000MK2', 'DAC', '中古',
      500000, 'in_stock', 'https://example.test/${sourceId}', '${now}', '${now}', '${now}', 1,
      'Technical Audio Devices', 'tad', 'D/Aコンバーター', 'dac', '["dac"]',
      'classified', 'DAC D/A Converter DAコンバーター', '${now}'
    );
  `);

  const result = d1(`
    SELECT p.source_id
    FROM products p
    JOIN product_search_projection sp ON sp.product_id = p.id
    JOIN product_search_fts ON product_search_fts.rowid = sp.product_id
    WHERE product_search_fts MATCH '"TAD" AND "1000"'
      AND p.source_id = '${sourceId}';
  `);
  const first = Array.isArray(result) ? result[0] : undefined;
  const rows = isRecord(first) && Array.isArray(first.results) ? first.results : [];
  assert.equal(rows.length, 1, "TAD 1000 must resolve through product_search_fts after migrations");
  assert.equal(isRecord(rows[0]) ? rows[0].source_id : undefined, sourceId);
  console.log("search migration integration check passed");
} finally {
  d1(`DELETE FROM products WHERE shop_key = 'integration' AND source_id = '${sourceId}';`);
}
