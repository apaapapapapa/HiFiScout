ALTER TABLE shop_sync_state ADD COLUMN queued_token TEXT;
ALTER TABLE shop_sync_state ADD COLUMN crawl_lease_token TEXT;
ALTER TABLE shop_sync_state ADD COLUMN crawl_lease_until TEXT;
