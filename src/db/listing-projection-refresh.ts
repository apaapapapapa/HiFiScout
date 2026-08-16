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

/**
 * Keep search projection and search-entity aggregation batched by shop. Only the expensive
 * identity candidate lookup is bounded to one manufacturer per query, so mixed-brand replay work
 * cannot create one large candidate scan without multiplying every other projection round trip.
 */
export async function refreshListingProjections(
  db: QueryableDatabase,
  listings: readonly ReplayedListing[],
  evaluatedAt: string,
): Promise<void> {
  const byShop = new Map<string, Set<string>>();
  for (const listing of listings) {
    const sourceIds = byShop.get(listing.shop_key) || new Set<string>();
    sourceIds.add(listing.source_id);
    byShop.set(listing.shop_key, sourceIds);
  }

  for (const [shopKey, sourceIdSet] of byShop) {
    const sourceIds = [...sourceIdSet];
    await syncProductSearchProjections(db, shopKey, sourceIds);
    await syncProductIdentityResolutions(db, shopKey, sourceIds, evaluatedAt, {
      candidateManufacturerChunkSize: 1,
      traceCandidateScopes: true,
    });
    // Resolver replay is listing-scoped. Shop-wide inactive membership cleanup belongs to a crawl,
    // where the observed inventory set is authoritative; pulling it into a remediation pass can
    // turn a handful of stale listings into an unbounded shop-wide entity projection.
    await syncProductSearchEntities(db, shopKey, sourceIds, {
      includeInactiveShopMembers: false,
    });
  }
}
