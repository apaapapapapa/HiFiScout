import { backfillKnowledgeCatalogPriceIndex } from "../src/db/knowledge-catalog-price-index-backfill.js";
import { createD1RestDatabase } from "./lib/d1-rest-database.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const database = createD1RestDatabase({
  accountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
  databaseId: requiredEnv("D1_DATABASE_ID"),
  apiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
});

const backfillKey = argument("--backfill-key", "price-index-history-v1");
const batchSize = positiveInteger(argument("--batch-size", "50"), "--batch-size");
const maxPages = positiveInteger(argument("--max-pages", "20"), "--max-pages");

let pages = 0;
let selectedCount = 0;
let writtenCount = 0;
let lastResult = await backfillKnowledgeCatalogPriceIndex(database, { backfillKey, batchSize });
pages += 1;
selectedCount += lastResult.selectedCount;
writtenCount += lastResult.writtenCount;

while (lastResult.hasMore && pages < maxPages) {
  lastResult = await backfillKnowledgeCatalogPriceIndex(database, { backfillKey, batchSize });
  pages += 1;
  selectedCount += lastResult.selectedCount;
  writtenCount += lastResult.writtenCount;
}

console.log(
  JSON.stringify({
    event: "knowledge_catalog_price_index_backfill_runner",
    backfillKey,
    pages,
    selectedCount,
    writtenCount,
    status: lastResult.status,
    afterPriceHistoryId: lastResult.afterPriceHistoryId,
    hasMore: lastResult.hasMore,
  }),
);
