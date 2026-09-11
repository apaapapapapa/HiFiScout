import type { QueryableDatabase } from "../../src/db/types.js";
import { AT } from "./d1-write-budget.js";

/** Healthy single-offer cards; every audit must still inspect all active listings. */
export async function addHealthListings(db: QueryableDatabase, from: number, through: number) {
  await db
    .prepare(`WITH RECURSIVE n(i) AS (
    VALUES(${from}) UNION ALL SELECT i+1 FROM n WHERE i < ${through})
    INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at,
      is_active,canonical_manufacturer_id,normalized_model,model_resolution_status,manufacturer_resolution_status,stock_status)
    SELECT i,'audiounion',CAST(i AS TEXT),'Model '||i,'https://example.test/'||i,'${AT}','${AT}','${AT}',
      1,'maker','MODEL'||i,'resolved','resolved','in_stock' FROM n;
    INSERT INTO product_identity_resolutions(listing_product_id,status,match_method,confidence,evaluated_at)
      SELECT id,'unresolved','none','low','${AT}' FROM products WHERE id BETWEEN ${from} AND ${through};
    INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id,offer_count,shop_count)
      SELECT id,'l-'||id,'unresolved_listing',id,1,1 FROM products WHERE id BETWEEN ${from} AND ${through};
    INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
      SELECT id,id,shop_key FROM products WHERE id BETWEEN ${from} AND ${through};`)
    .run();
}
