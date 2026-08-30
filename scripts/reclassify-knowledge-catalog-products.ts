import { reclassifyProductsFromKnowledgeCatalog } from "../src/db/knowledge-catalog-repository.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { createD1RestDatabase } from "./lib/d1-rest-database.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function reclassifyKnowledgeCatalogProducts(
  db: QueryableDatabase,
  evaluatedAt = new Date().toISOString(),
): Promise<number> {
  const reclassifiedProducts = await reclassifyProductsFromKnowledgeCatalog(db, evaluatedAt);
  console.log(
    JSON.stringify({
      event: "knowledge_catalog_reclassification_complete",
      reclassifiedProducts,
    }),
  );
  return reclassifiedProducts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const database = createD1RestDatabase({
    accountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
    databaseId: requiredEnv("D1_DATABASE_ID"),
    apiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
  });
  await reclassifyKnowledgeCatalogProducts(database);
}
