-- Retention pages the settled remediation backlog in bounded statements, and every page reran
--   WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < ?
--   ORDER BY resolved_at ASC, id ASC LIMIT ?
-- with no index covering that predicate. The queue's existing partial indexes are for 'failed',
-- 'pending' and 'processing'; 'resolved' — the terminal state, and by far the largest share of the
-- table — had none. SQLite therefore planned it as
--   SCAN data_quality_remediation_queue USING INDEX idx_dq_remediation_queue_listing
--   USE TEMP B-TREE FOR ORDER BY
-- a full read plus a sort, per page. One page a day was affordable; paging a 78k-row backlog is not,
-- and multiplying that scan by eighty inside one maintenance invocation is the exact cost the
-- retention change exists to remove.
--
-- With this index the same statement plans as
--   SEARCH data_quality_remediation_queue USING COVERING INDEX
--     idx_dq_remediation_queue_resolved (resolved_at>? AND resolved_at<?)
-- an ordered range over only the rows being deleted, with no sort and no table reads.
--
-- Partial on `status = 'resolved'` so it costs one entry per job at the moment it settles, and
-- nothing on the pending/processing writes that happen on the remediation hot path.
CREATE INDEX IF NOT EXISTS idx_dq_remediation_queue_resolved
  ON data_quality_remediation_queue(resolved_at, id)
  WHERE status = 'resolved';
