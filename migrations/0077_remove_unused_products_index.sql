-- Remove idx_products_last_seen, which is never used by actual code paths.
--
-- Query plan analysis confirms that all real queries using last_seen_at have
-- additional WHERE conditions (is_active) that cause SQLite to select more
-- specific indexes:
--
-- - Maintenance queries (is_active = 0) use idx_products_inactive_last_seen
-- - Inventory recheck (is_active = 1) uses idx_products_shop_active_quality
--
-- The pattern queries that would use idx_products_last_seen (ordering only by
-- last_seen_at with no is_active filter) do not exist in the codebase.

DROP INDEX IF EXISTS idx_products_last_seen;
