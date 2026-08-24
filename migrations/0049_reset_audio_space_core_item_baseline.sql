-- Audio Space Core's /used page contains a large historical archive of sold listings below its
-- current inventory. The crawler now ignores those sold rows, so the old last_item_count is not a
-- comparable baseline for the first crawl after rollout. Reset only that guard value; the next
-- successful crawl records the current-inventory count and retires the omitted historical rows.
UPDATE shop_sync_state
SET last_item_count = NULL
WHERE shop_key = 'audio-space-core';
