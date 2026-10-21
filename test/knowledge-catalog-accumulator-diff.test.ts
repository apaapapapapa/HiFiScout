import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { accumulateKnowledgeCatalogCandidateRows } from "../src/catalog/knowledge-catalog.js";
import {
  prepareScheduledKnowledgeCatalogCandidates,
  serializeCandidateAccumulator,
} from "../src/db/knowledge-catalog-candidate-refresh.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { AT, database } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";

test("accumulator serialization ignores object and set insertion order", () => {
  const [value] = accumulateKnowledgeCatalogCandidateRows(undefined, [
    {
      manufacturer_id: "luxman",
      model: "C-10",
      shop_key: "b",
      category_ids: '["AMP.PRE","AMP.POWER"]',
      source_url: "https://example.test/b",
    },
    {
      manufacturer_id: "luxman",
      model: "C-10",
      shop_key: "a",
      category_ids: '["AMP.PRE"]',
      source_url: "https://example.test/a",
    },
  ]).values();
  const reverse = {
    ...value,
    shops: new Set([...value.shops].reverse()),
    categories: new Set([...value.categories].reverse()),
    sourceUrls: new Set([...value.sourceUrls].reverse()),
    identityRejectionReasons: new Map([...value.identityRejectionReasons].reverse()),
  };
  assert.equal(serializeCandidateAccumulator(value), serializeCandidateAccumulator(reverse));
});

test("replaying the same staged accumulator writes zero rows without an additional read", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`INSERT INTO products(shop_key,source_id,title,source_url,
      canonical_manufacturer_id,manufacturer,model,first_seen_at,last_seen_at,last_changed_at)
      VALUES ('staged','one','C-10','https://example.test/one','luxman','LUXMAN','C-10',?1,?1,?1)`)
      .bind(AT)
      .run();
    let staged = false;
    const replay: QueryableDatabase = {
      prepare: (sql) => db.prepare(sql),
      async batch<T>(statements: D1PreparedStatement[]) {
        if (!staged && statements.length > 1) {
          staged = true;
          const effect = statements.slice(0, -1);
          // Replay exactly the production statement and binds before advancing the shared fence.
          await db.batch(effect);
          const measured = measureD1Cost(db);
          await measured.db.batch(effect);
          assert.equal(measured.metrics().rowsWritten, 0);
          assert.equal(measured.metrics().sqlStatements, 1);
        }
        return db.batch<T>(statements);
      },
    };
    await prepareScheduledKnowledgeCatalogCandidates(replay, new Date(AT));
    assert.ok(staged);
    const row = await db
      .prepare("SELECT active_listing_count FROM knowledge_catalog_candidates")
      .first<{ active_listing_count: number }>();
    assert.equal(row?.active_listing_count, 1);
  } finally {
    await dispose();
  }
});
