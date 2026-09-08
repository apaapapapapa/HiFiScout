ALTER TABLE shop_sync_state ADD COLUMN admin_paused INTEGER NOT NULL DEFAULT 0 CHECK(admin_paused IN (0, 1));
ALTER TABLE shop_sync_state ADD COLUMN admin_pause_updated_at TEXT;
ALTER TABLE shop_sync_state ADD COLUMN previous_item_count INTEGER;
