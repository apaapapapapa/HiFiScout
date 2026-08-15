/**
 * The one dependency order every remediation replay must follow after a listing's canonical
 * fields change: search projection, then Product Identity, then the Phase 4 search entity and its
 * offer membership. Rebuilding the search entity first would immediately make it stale.
 */

import { syncProductIdentityResolutions } from "./product-identity-repository.js";
import { syncProductSearchEntities } from "./product-search-entity-repository.js";
import { syncProductSearchProjections } from "./product-search-projection-repository.js";
import type { QueryableDatabase } from "./types.js";

export interface ReplayedListing {
  shop_key: string;
  source_id: string;
}

export async function refreshListingProjections(
  db: QueryableDatabase,
  listings: readonly ReplayedListing[],
  evaluatedAt: string,
): Promise<void> {
  const byShop = new Map<string, string[]>();
  for (const listing of listings) {
    const sourceIds = byShop.get(listing.shop_key) || [];
    sourceIds.push(listing.source_id);
    byShop.set(listing.shop_key, sourceIds);
  }
  for (const [shopKey, sourceIds] of byShop) {
    await syncProductSearchProjections(db, shopKey, sourceIds);
    await syncProductIdentityResolutions(db, shopKey, sourceIds, evaluatedAt);
    await syncProductSearchEntities(db, shopKey, sourceIds);
  }
}
