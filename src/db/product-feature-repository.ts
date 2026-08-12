import { normalizeFeatureFacts } from "../catalog/product-features.js";

const CHUNK_SIZE = 50;

async function runBatches(db, statements) {
  for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
    await db.batch(statements.slice(i, i + CHUNK_SIZE));
  }
}

export async function syncObservedProductFeatureFacts(db, shopKey, products, observedAt) {
  if (!products.length) return 0;
  const idBySource = new Map();
  const sourceIds = [...new Set(products.map((product) => product.sourceId))];
  for (let i = 0; i < sourceIds.length; i += CHUNK_SIZE) {
    const chunk = sourceIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT id, source_id FROM products WHERE shop_key = ? AND source_id IN (${placeholders})`,
      )
      .bind(shopKey, ...chunk)
      .all();
    for (const row of result.results || []) idBySource.set(row.source_id, row.id);
  }

  const statements = [];
  let factCount = 0;
  for (const product of products) {
    const productId = idBySource.get(product.sourceId);
    if (!productId) continue;
    const titleFacts = normalizeFeatureFacts(product.featureFacts || []).filter(
      (fact) => fact.source === "title",
    );
    statements.push(
      db
        .prepare("DELETE FROM product_feature_facts WHERE product_id = ? AND source = 'title'")
        .bind(productId),
    );
    for (const fact of titleFacts) {
      statements.push(
        db
          .prepare(`
        INSERT OR REPLACE INTO product_feature_facts(product_id, feature_id, state, source, confidence, verified_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
          .bind(
            productId,
            fact.featureId,
            fact.state,
            fact.source,
            fact.confidence,
            fact.verifiedAt || observedAt,
          ),
      );
      factCount += 1;
    }
  }
  await runBatches(db, statements);
  return factCount;
}
