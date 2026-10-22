-- Listing freshness for shops whose crawl cannot see their whole inventory.
--
-- A listing that failed one detail recheck is confirmed before any never-checked listing is
-- visited. Only listings carrying a failure are indexed, so this stays a handful of entries per shop
-- and is rewritten only when a recheck records or clears a failure.
CREATE INDEX IF NOT EXISTS idx_products_inventory_recheck_confirm
  ON products(shop_key, last_inventory_check_attempt_at, last_seen_at)
  WHERE is_active = 1 AND inventory_check_failures > 0;

-- Stale-listing expiry seeks a shop's oldest-seen active listings and stops at its cutoff.
CREATE INDEX IF NOT EXISTS idx_products_active_last_seen
  ON products(shop_key, last_seen_at)
  WHERE is_active = 1;

-- Superseded by idx_products_inventory_recheck_attempt (0007), which every candidate seek names with
-- INDEXED BY; nothing has read this one since. Dropping it keeps a listing's insert and deactivation
-- at the same index-entry count once idx_products_active_last_seen exists.
DROP INDEX IF EXISTS idx_products_inventory_recheck;
