-- The finalizer's remediation backlog selector and its COUNT filter on
--   verification_status = 'verified'
--   AND (last_remediated_at IS NULL OR last_remediated_at < last_verified_at)
-- The existing (verification_status, last_remediated_at, last_verified_at, id) index can only seek
-- the status, so both statements walked every verified Catalog entry to find a handful still owed a
-- replay. This partial index holds just that backlog, in selector order. Its WHERE clause must stay
-- textually identical to PENDING_REMEDIATION_PREDICATE so SQLite can prove the query implies it.
-- Rows enter it when (re)verified and leave it when their replay completes.
CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_products_remediation_backlog
  ON knowledge_catalog_products(last_verified_at, id)
  WHERE verification_status = 'verified'
    AND (last_remediated_at IS NULL OR last_remediated_at < last_verified_at);
