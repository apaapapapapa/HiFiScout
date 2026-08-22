-- Track the last time a logical crawl child was handed to Cloudflare Queues separately from
-- queued_at, which is the stable identity timestamp for that child. A scheduler recovery may
-- re-send the same child without replacing its token or moving it to the queue tail as a new job.
ALTER TABLE shop_sync_state ADD COLUMN queued_last_sent_at TEXT;

-- Existing reservations predate this column. Treat their original queue timestamp as their last
-- delivery so the five-minute scheduler can recover any rollout orphan once the recovery window
-- has elapsed.
UPDATE shop_sync_state
SET queued_last_sent_at = queued_at
WHERE queued_at IS NOT NULL;
