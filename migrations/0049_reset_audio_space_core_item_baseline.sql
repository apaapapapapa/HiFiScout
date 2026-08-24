-- Audio Space Core's /used page contains a large historical archive of sold listings below its
-- current inventory. The crawler now ignores those sold rows, so the old last_item_count is not a
-- comparable baseline for the first crawl after rollout. Reset only that guard value to zero: the
-- schema keeps it NOT NULL, while zero is below the suspicious-drop baseline and the next successful
-- crawl replaces it with the current-inventory count before retiring the omitted historical rows.
UPDATE shop_sync_state
SET last_item_count = 0
WHERE shop_key = 'audio-space-core';
