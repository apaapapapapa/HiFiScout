-- Constant-size schema expansion only. Historical price aggregation runs in scheduled work.
-- Both nullable additions preserve the previous Worker's explicit-column reads and writes.
ALTER TABLE knowledge_catalog_price_index_recent_backfill_runs ADD COLUMN page_token TEXT;
ALTER TABLE knowledge_catalog_price_index_recent_backfill_runs ADD COLUMN next_batch_after TEXT;
