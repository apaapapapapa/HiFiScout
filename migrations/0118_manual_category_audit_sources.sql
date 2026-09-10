-- Manual category authority resolves two fixed audit sources on deploy. Keep this lookup
-- proportional to the audited set without indexing unrelated catalog evidence.
CREATE INDEX IF NOT EXISTS idx_knowledge_catalog_sources_manual_audit
  ON knowledge_catalog_sources(source_url, product_id)
  WHERE source_type = 'manual_verified' AND status = 'active';
