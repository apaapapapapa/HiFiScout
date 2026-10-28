import type { QueryableDatabase } from "../src/db/types.js";
import { createD1RestDatabase } from "./lib/d1-rest-database.js";

/** Routes the October 2026 storefront renewal retired; they no longer reach a product page. */
export const AUDIOUNION_LEGACY_DETAIL_PREFIX = "https://www.audiounion.jp/ct/detail/used/";
/** About 650 legacy rows were active at the 2026-10-22 baseline; anything far larger is not them. */
export const MAX_RETIRED_LISTINGS = 2_000;
const BATCH_SIZE = 100;

/**
 * Operator-authorized retirement of AudioUnion's legacy `/ct/detail/used/<id>/` listings.
 *
 * The seller publishes no mapping to the new `/shop/g/g<code>/` goods, collection stores
 * `goods:<code>` IDs and rechecks select only the new prefix, so these rows can never be observed
 * again. A retired route is not sale evidence: in-stock rows become unknown and other states are
 * kept. Rows are not merged into new goods. Each bounded UPDATE fires the existing projection and
 * public-meta triggers; a repeated run finds nothing left. This is not a migration because a data
 * statement in every test database's migration replay changes the measured D1 workloads.
 */
export async function retireAudioUnionLegacyListings(
  db: QueryableDatabase,
  retiredAt = new Date().toISOString(),
): Promise<number> {
  const pattern = `${AUDIOUNION_LEGACY_DETAIL_PREFIX}%`;
  const pending = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM products WHERE shop_key = 'audiounion' AND is_active = 1 AND source_url LIKE ?",
    )
    .bind(pattern)
    .first<{ n: number }>();
  const expected = Number(pending?.n ?? 0);
  if (expected > MAX_RETIRED_LISTINGS)
    throw new Error(`audiounion_legacy_retirement_unexpected_scope: ${expected} active rows`);
  let retired = 0;
  for (;;) {
    const batch = await db
      .prepare(
        `UPDATE products
        SET is_active = 0,
          stock_status = CASE WHEN stock_status = 'in_stock' THEN 'unknown' ELSE stock_status END,
          last_changed_at = ?
        WHERE id IN (
          SELECT id FROM products
          WHERE shop_key = 'audiounion' AND is_active = 1 AND source_url LIKE ?
          ORDER BY id LIMIT ?
        )
        RETURNING id`,
      )
      .bind(retiredAt, pattern, BATCH_SIZE)
      .all<{ id: number }>();
    const count = batch.results?.length ?? 0;
    retired += count;
    if (count < BATCH_SIZE || retired > MAX_RETIRED_LISTINGS) break;
  }
  console.log(JSON.stringify({ event: "audiounion_legacy_listings_retired", expected, retired }));
  return retired;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// Invoked only by the deployment-identity-gated maintenance workflow step.
if (import.meta.url === `file://${process.argv[1]}`) {
  await retireAudioUnionLegacyListings(
    createD1RestDatabase({
      accountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
      databaseId: requiredEnv("D1_DATABASE_ID"),
      apiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
    }),
  );
}
