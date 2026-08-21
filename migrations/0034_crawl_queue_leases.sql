-- `queued_token` identifies the currently valid queue dispatch for one shop.
ALTER TABLE shop_sync_state ADD COLUMN queued_token TEXT;
-- The execution lease prevents concurrent crawl consumers for the same shop.
ALTER TABLE shop_sync_state ADD COLUMN crawl_lease_token TEXT;
ALTER TABLE shop_sync_state ADD COLUMN crawl_lease_until TEXT;
