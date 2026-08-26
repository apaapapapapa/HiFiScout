-- When a shop's derived work was last fully consistent, as opposed to when its inventory was.
--
-- `last_success_at` answers "how fresh are this shop's listings". It cannot also answer "is search
-- showing them", because a crawl may hand its remaining projection chunks to the continuation
-- sweep, or lose a stage to a failure, and still have collected a complete inventory. Reporting one
-- number for both meant a shop whose projections had stopped completing looked healthy.
ALTER TABLE shop_sync_state ADD COLUMN last_projection_at TEXT;

-- Existing rows are seeded from the inventory watermark rather than left null. Before this column
-- existed a successful crawl ran its derived work inline, so the last success is the best evidence
-- available of when the shop was last consistent; starting from null would instead report every
-- shop as never projected until its next crawl.
UPDATE shop_sync_state SET last_projection_at = last_success_at WHERE last_projection_at IS NULL;
