-- Section 16: the index coverage the two recorded full table reads were waiting on.
--
-- `test/remediation-query-plans.test.ts` recorded both costs rather than hiding them. This migration
-- supplies the indexes each fix names; the repository statements are rewritten in the same change so
-- the planner can actually reach them.

-- 1. Replay seeding read every listing on every five-minute tick.
--
-- The staleness selector was one disjunction over ten columns, which no single index can serve. It
-- becomes one bounded selector per stage, so each stage needs its own way in. Model, projection,
-- manufacturer/model/classification status and identity already have theirs (0005, 0017, 0023,
-- 0024, 0025); manufacturer and category versions did not.
CREATE INDEX IF NOT EXISTS idx_products_manufacturer_resolver_version
  ON products(manufacturer_resolver_version, is_active, id);

-- Category is the one stage whose version is not a column: it lives in
-- `metadata_json.categoryClassification.version` (see 0025). An expression index keeps that storage
-- decision intact while still bounding the selector. The expression must stay character-for-column
-- identical to the one the repository issues, or SQLite will not match it.
CREATE INDEX IF NOT EXISTS idx_products_category_classifier_version
  ON products(
    COALESCE(CAST(json_extract(metadata_json, '$.categoryClassification.version') AS INTEGER), 0),
    is_active,
    id
  );

-- "Active listing with no identity resolution row at all" is an anti-join, so no predicate can make
-- it selective. What it can be is cheap: an id-only partial index is the active-listing rowid list,
-- walked in id order, with one integer-primary-key probe per row and no listing payload read.
CREATE INDEX IF NOT EXISTS idx_products_active_ids
  ON products(id)
  WHERE is_active = 1;

-- 2. Queue claiming scanned the queue, then sorted it.
--
-- The claimable states are an OR over different columns, so one index could never serve both, and
-- `(status, available_at, priority DESC, id)` disagreed with `ORDER BY priority DESC, available_at,
-- id` even for a single state. One partial index per state, in the order the claim actually asks
-- for, lets each half of a UNION ALL walk its index and stop at LIMIT.
CREATE INDEX IF NOT EXISTS idx_dq_remediation_queue_pending
  ON data_quality_remediation_queue(priority DESC, available_at, id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_dq_remediation_queue_processing
  ON data_quality_remediation_queue(priority DESC, available_at, id)
  WHERE status = 'processing';

-- The index those two replace. It was created for claiming and nothing else reaches it: retention
-- (`src/maintenance.ts`) filters `status = 'resolved'`, which its partial WHERE excludes. Keeping it
-- would be write cost for no read.
DROP INDEX IF EXISTS idx_dq_remediation_queue_claim;
