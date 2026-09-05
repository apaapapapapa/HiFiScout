-- Old/in-flight CSV jobs keep their original codec. New requests opt into full table archives.
ALTER TABLE product_audit_export_jobs
  ADD COLUMN format TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv', 'complete'));
ALTER TABLE knowledge_catalog_export_jobs
  ADD COLUMN format TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv', 'complete'));
