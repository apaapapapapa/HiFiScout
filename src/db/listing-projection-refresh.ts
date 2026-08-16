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
 * Remediation is deliberately projected one listing at a time.
 *
 * Identity projection loads verified catalog candidates for every manufacturer represented by the
 * input batch. A mixed hardware batch can therefore turn a small queue claim into a large remote D1
 * read even after search-entity cleanup is listing-scoped. Normal crawls still use their batched
 * sync path; only resolver replay pays this stronger bound.
 */
export async function refreshListingProjections(
  db: QueryableDatabase,
  listings: readonly ReplayedListing[],
  evaluatedAt: string,
): Promise<void> {
  const uniqueListings = [
    ...new Map(
      listings.map((listing) => [`${listing.shop_key}\u0000${listing.source_id}`, listing] as const),
    ).values(),
  ];

  for (const [index, listing] of uniqueListings.entries()) {
    const { shop_key: shopKey, source_id: sourceId } = listing;
    const startedAt = Date.now();
    console.log(
      JSON.stringify({
        event: "data_quality_remediation_projection_listing_start",
        shop_key: shopKey,
        source_id: sourceId,
        listing_index: index + 1,
        listing_count: uniqueListings.length,
      }),
    );

    await syncProductSearchProjections(db, shopKey, [sourceId]);
    await syncProductIdentityResolutions(db, shopKey, [sourceId], evaluatedAt);
    // Resolver replay is listing-scoped. Shop-wide inactive membership cleanup belongs to a crawl,
    // where the observed inventory set is authoritative; pulling it into a remediation pass can
    // turn a handful of stale listings into an unbounded shop-wide entity projection.
    await syncProductSearchEntities(db, shopKey, [sourceId], {
      includeInactiveShopMembers: false,
    });

    console.log(
      JSON.stringify({
        event: "data_quality_remediation_projection_listing_complete",
        shop_key: shopKey,
        source_id: sourceId,
        listing_index: index + 1,
        listing_count: uniqueListings.length,
        duration_ms: Date.now() - startedAt,
      }),
    );
  }
}
