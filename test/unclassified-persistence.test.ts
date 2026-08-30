import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { runDataQualityRemediationSweep } from "../src/db/data-quality-remediation-service.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import type { CatalogProductUpsertInput } from "../src/catalog/types.js";
import { asQueryableDatabase, captureDatabase } from "./helpers/d1.js";

interface CapturedStatement {
  sql: string;
  binds: unknown[];
}

function captureDb(existing: Record<string, unknown> & { id: number; source_id: string }) {
  const statements: CapturedStatement[] = [];
  return asQueryableDatabase({
    statements,
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            sql,
            binds,
            async all() {
              if (/SELECT id, source_id, manufacturer/.test(sql)) return { results: [existing] };
              if (/SELECT id, source_id FROM products/.test(sql))
                return { results: [{ id: existing.id, source_id: existing.source_id }] };
              if (/SELECT id, source_id, price_yen/.test(sql)) return { results: [existing] };
              return { results: [] };
            },
          };
        },
      };
    },
    async batch(batch: CapturedStatement[]) {
      statements.push(...batch);
      return batch.map(() => ({ meta: { changes: 1 } }));
    },
  });
}

test("unclassified products persist the sentinel without public category membership", async () => {
  const existing = {
    id: 1,
    source_id: "p1",
    manufacturer: "Example",
    raw_manufacturer: "Example",
    manufacturer_id: "example",
    model: "ABC-123",
    title: "Example ABC-123",
    category: "DAP",
    raw_category: "DAP",
    primary_category_id: "dap",
    category_ids: '["dap"]',
    classification_status: "classified",
    search_aliases: "DAP digital audio player",
    condition_text: "中古",
    price_yen: 100000,
    stock_status: "in_stock",
    source_url: "https://example.test/p1",
    last_seen_at: "2026-08-11T00:00:00.000Z",
    is_active: 1,
  };
  const product: CatalogProductUpsertInput = {
    sourceId: "p1",
    manufacturer: "Example",
    rawManufacturer: "Example",
    manufacturerId: "example",
    model: "ABC-123",
    title: "Example ABC-123",
    category: "未分類",
    rawCategory: "DAP",
    primaryCategoryId: "other",
    categoryIds: [],
    classificationStatus: "unclassified",
    searchAliases: "",
    conditionText: "中古",
    priceYen: 100000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/p1",
  };
  const db = captureDb(existing);

  await upsertProducts(db, "fujiya-avic", [product], "2026-08-11T01:00:00.000Z");

  const categoryStatements = db.statements.filter((statement) =>
    /product_categories/.test(statement.sql),
  );
  assert.ok(
    categoryStatements.some((statement) => /DELETE FROM product_categories/.test(statement.sql)),
  );
  const insert = categoryStatements.find((statement) =>
    /INSERT OR IGNORE INTO product_categories/.test(statement.sql),
  );
  assert.equal(insert, undefined);

  const update = db.statements.find((statement) => /UPDATE products SET/.test(statement.sql));
  assert.ok(update);
  assert.ok(update.binds.includes('["unclassified"]'));
  assert.ok(update.binds.includes("unclassified"));
});

const REPLAY_JOB_ROW = {
  id: 1,
  work_key: "auto:classify_category:7",
  work_type: "classify_category",
  listing_product_id: 7,
  entity_id: "7",
  reason: "stale classifier version",
  source: "auto",
  status: "processing",
  priority: 100,
  attempt_count: 1,
  max_attempts: 3,
  available_at: "2026-08-22T00:00:00.000Z",
  claimed_at: "2026-08-22T00:00:00.000Z",
  lease_expires_at: "2026-08-22T00:05:00.000Z",
  resolved_at: null,
  last_error: "",
  created_at: "2026-08-22T00:00:00.000Z",
  updated_at: "2026-08-22T00:00:00.000Z",
};

/** A listing with no category evidence at all, so the classifier answers "unclassified". */
const UNCLASSIFIED_LISTING_ROW = {
  id: 7,
  shop_key: "fujiya-avic",
  source_id: "listing-7",
  manufacturer: "Example",
  raw_manufacturer: "Example",
  normalized_raw_manufacturer: "example",
  manufacturer_id: "example",
  canonical_manufacturer_id: "example",
  manufacturer_resolution_status: "resolved",
  manufacturer_resolution_method: "bootstrap_alias",
  manufacturer_resolution_confidence: "high",
  manufacturer_resolver_version: 1,
  model: "EX-1",
  raw_model: "EX-1 ブラック",
  normalized_model: "EX1",
  presentation_color: "",
  model_resolution_status: "resolved",
  model_resolution_method: "seller_model",
  model_resolution_confidence: "medium",
  model_resolver_version: 1,
  title: "Example EX-1",
  category: "",
  raw_category: "",
  primary_category_id: "other",
  category_ids: '["other"]',
  classification_status: "unclassified",
  search_aliases: "",
  metadata_json: "{}",
  remediation_projection_required: 0,
  remediation_projection_token: "",
};

test("the data-quality replay persists the same unclassified shape the crawl path writes", async () => {
  const db = captureDatabase((statement) => {
    const sql = statement.sql;
    if (/WHEN p\.manufacturer_resolver_version < \? THEN 'resolve_manufacturer'/.test(sql))
      return [];
    if (/FROM data_quality_remediation_queue INDEXED BY idx_dq_remediation_queue_pending/.test(sql))
      return [{ id: 1 }];
    if (/SELECT \*\s+FROM data_quality_remediation_queue\s+WHERE id IN/.test(sql))
      return [REPLAY_JOB_ROW];
    if (/SELECT attempt_count, max_attempts FROM data_quality_remediation_queue/.test(sql))
      return [{ attempt_count: 1, max_attempts: 3 }];
    if (/FROM products\s+WHERE id = \?/.test(sql)) return [UNCLASSIFIED_LISTING_ROW];
    return [];
  });

  await runDataQualityRemediationSweep(db, {
    seedLimit: 10,
    claimLimit: 10,
    leaseSeconds: 300,
    now: new Date("2026-08-22T00:00:00.000Z"),
  });

  const replay = db.calls.find((call) => /UPDATE products\s+SET manufacturer = \?/.test(call.sql));
  assert.ok(replay, "a classify_category job must replay the listing's derived fields");
  assert.equal(replay.binds[10], "ブラック", "the replay persists every model-resolver field");
  assert.equal(replay.binds[16], "unclassified", "the replay writes the unclassified sentinel");
  assert.equal(
    replay.binds[17],
    '["unclassified"]',
    "the replay must persist [primary_category_id], never the classifier's in-memory empty array",
  );
  assert.equal(
    replay.binds[18],
    '["unclassified"]',
    "an unclassified listing is directly in exactly one category: the sentinel, once",
  );
  assert.equal(replay.binds[19], "unclassified");
  const metadata = JSON.parse(String(replay.binds[21])) as {
    modelNormalization?: { presentationColors?: string[] };
  };
  assert.deepEqual(metadata.modelNormalization?.presentationColors, ["ブラック"]);
});
