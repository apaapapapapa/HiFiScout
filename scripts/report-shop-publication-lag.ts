import { parseArgs } from "node:util";
import { createD1RestDatabase } from "./lib/d1-rest-database.js";
import { reportShopPublicationLag } from "./lib/shop-publication-lag.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "30" },
    at: { type: "string" },
  },
});
const days = Number(values.days);
if (!/^\d+$/u.test(values.days) || !Number.isSafeInteger(days) || days < 1 || days > 90) {
  throw new Error("--days must be an integer between 1 and 90");
}
const end = values.at ? new Date(values.at) : new Date();
const start = new Date(end.getTime() - days * 86_400_000);
const database = createD1RestDatabase({
  accountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
  databaseId: requiredEnv("D1_DATABASE_ID"),
  apiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
});
const report = await reportShopPublicationLag(database, start, end);
console.log(`SHOP_PUBLICATION_LAG_REPORT ${JSON.stringify(report)}`);
