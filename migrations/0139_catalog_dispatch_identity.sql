-- Nullable keys keep existing Workers/runs readable during a rolling deployment.
ALTER TABLE knowledge_catalog_review_runs ADD COLUMN dispatch_key TEXT;
ALTER TABLE knowledge_catalog_review_runs ADD COLUMN candidate_generation TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_catalog_review_runs ADD COLUMN target_date TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_catalog_review_dispatch_key ON knowledge_catalog_review_runs(dispatch_key);
CREATE INDEX idx_catalog_review_status_id ON knowledge_catalog_review_runs(status, id);
