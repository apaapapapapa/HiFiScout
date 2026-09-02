-- Phase 7 follow-up: crawl execution is now owned by per-shop Durable Objects and the
-- transport-neutral dispatch_* generation fence. Remove the rolling-deploy bridge only after
-- migration 0072 has copied legacy Queue state into dispatch_*.
DROP TRIGGER IF EXISTS trg_shop_sync_dispatch_to_legacy_insert;
DROP TRIGGER IF EXISTS trg_shop_sync_dispatch_to_legacy_update;
DROP TRIGGER IF EXISTS trg_shop_sync_legacy_to_dispatch_insert;
DROP TRIGGER IF EXISTS trg_shop_sync_legacy_to_dispatch_update;

DROP INDEX IF EXISTS idx_shop_sync_state_queued_at;

ALTER TABLE shop_sync_state DROP COLUMN queued_at;
ALTER TABLE shop_sync_state DROP COLUMN queued_token;
ALTER TABLE shop_sync_state DROP COLUMN queued_last_sent_at;
ALTER TABLE shop_sync_state DROP COLUMN crawl_lease_token;
ALTER TABLE shop_sync_state DROP COLUMN crawl_lease_until;
