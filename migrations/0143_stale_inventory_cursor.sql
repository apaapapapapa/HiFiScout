-- Bounded Stage A walk through the existing active-last-seen index. No product backfill/index.
ALTER TABLE shop_sync_state ADD COLUMN stale_inventory_cursor_seen_at TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_sync_state ADD COLUMN stale_inventory_cursor_id INTEGER NOT NULL DEFAULT 0;
