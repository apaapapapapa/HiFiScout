import { repairProductSearchProjection } from "../src/db/product-search-gap-repair.js";
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

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
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

const result = await repairProductSearchProjection(database, {
  batchSize: positiveInteger(argument("--batch-size", "20"), "--batch-size"),
  maxListings: positiveInteger(argument("--max-listings", "100"), "--max-listings"),
});

console.log(JSON.stringify({ event: "product_search_projection_repair", ...result }));
if (hasFlag("--require-repair") && !result.repaired) {
  throw new Error(
    "Deploy failed, but Product Search projection was already consistent; refusing an unrelated automatic rerun",
  );
}
