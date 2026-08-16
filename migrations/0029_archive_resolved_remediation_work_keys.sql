-- Automatic remediation work keys are dedupe keys for *active* work, not permanent tombstones.
--
-- A listing can become stale again after an automatic replay has already resolved the same stored
-- resolver-version tuple (for example, a concurrent/older crawler write can restore an old resolver
-- version). The queue's UNIQUE(work_key) plus the seeder's NOT EXISTS historically made that state
-- unrecoverable: the old resolved row permanently reserved the key, so no new work could be seeded.
--
-- Preserve the full history but release the canonical dedupe key once automatic work resolves. A
-- failed row deliberately keeps its canonical key so terminal failures remain visible and cannot
-- silently enter an infinite automatic retry loop.

UPDATE data_quality_remediation_queue
SET work_key = work_key || ':resolved:' || id
WHERE status = 'resolved'
  AND work_key LIKE 'auto:%'
  AND work_key NOT LIKE '%:resolved:' || id;

CREATE TRIGGER IF NOT EXISTS trg_dq_remediation_archive_resolved_auto_work_key
AFTER UPDATE OF status ON data_quality_remediation_queue
WHEN NEW.status = 'resolved'
  AND OLD.status <> 'resolved'
  AND NEW.work_key LIKE 'auto:%'
BEGIN
  UPDATE data_quality_remediation_queue
  SET work_key = NEW.work_key || ':resolved:' || NEW.id
  WHERE id = NEW.id;
END;
