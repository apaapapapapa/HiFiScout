-- The new scheduler keeps a queued child reserved until its Queue consumer or DLQ explicitly
-- releases it. Before that behavior ships, clear only old reservations left by the previous
-- time-based supersession/ACK behavior so they cannot become permanent rollout orphans.
--
-- A currently executing crawl is deliberately excluded. ISO-8601 timestamps are parsed through
-- julianday() rather than compared lexically.
UPDATE shop_sync_state
SET queued_at = NULL,
    queued_token = NULL
WHERE queued_at IS NOT NULL
  AND julianday(queued_at) <= julianday('now', '-120 minutes')
  AND (
    crawl_lease_until IS NULL
    OR julianday(crawl_lease_until) <= julianday('now')
  );
