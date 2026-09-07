-- Catalog-owned relationships never reference transient product_search_entities.
CREATE TABLE knowledge_catalog_model_families (
  id TEXT PRIMARY KEY,
  manufacturer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(manufacturer_id, name)
);

CREATE TABLE knowledge_catalog_model_facts (
  id TEXT PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE,
  related_product_id INTEGER REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE,
  family_id TEXT REFERENCES knowledge_catalog_model_families(id),
  position INTEGER,
  relation_type TEXT CHECK(relation_type IN ('successor', 'variant')),
  state TEXT NOT NULL CHECK(state IN ('candidate', 'verified', 'rejected', 'removed')),
  -- Keep the evidence reference and snapshot when a source is removed; the read marks it due.
  source_id INTEGER,
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('source', 'manual')),
  source_url TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '',
  manual_note TEXT NOT NULL DEFAULT '',
  manufacturer_justification TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  verified_at TEXT,
  review_due_at TEXT,
  updated_at TEXT NOT NULL,
  audit_actor TEXT NOT NULL,
  CHECK(product_id IS NOT related_product_id),
  CHECK(position IS NULL OR (position BETWEEN 0 AND 1000 AND family_id IS NOT NULL)),
  CHECK((related_product_id IS NOT NULL AND relation_type IS NOT NULL AND family_id IS NULL)
     OR (related_product_id IS NULL AND relation_type IS NULL AND family_id IS NOT NULL))
);
CREATE INDEX idx_model_facts_product ON knowledge_catalog_model_facts(product_id, id) WHERE state <> 'removed';
CREATE INDEX idx_model_facts_related ON knowledge_catalog_model_facts(related_product_id, id) WHERE state <> 'removed';
CREATE INDEX idx_model_facts_family ON knowledge_catalog_model_facts(family_id, id) WHERE state <> 'removed';
CREATE INDEX idx_model_facts_source ON knowledge_catalog_model_facts(source_id, id);
CREATE INDEX idx_model_facts_review ON knowledge_catalog_model_facts(state, review_due_at, id);
CREATE UNIQUE INDEX idx_model_relation_unique
  ON knowledge_catalog_model_facts(product_id, related_product_id, relation_type) WHERE state <> 'removed';
CREATE UNIQUE INDEX idx_model_family_member_unique
  ON knowledge_catalog_model_facts(family_id, product_id) WHERE state <> 'removed';
CREATE UNIQUE INDEX idx_model_family_position_unique
  ON knowledge_catalog_model_facts(family_id, position) WHERE state = 'verified' AND position IS NOT NULL;
-- Verified succession is a chain. Branching variants use the separate symmetric variant type.
CREATE UNIQUE INDEX idx_model_successor_outgoing
  ON knowledge_catalog_model_facts(product_id) WHERE state = 'verified' AND relation_type = 'successor';
CREATE UNIQUE INDEX idx_model_successor_incoming
  ON knowledge_catalog_model_facts(related_product_id) WHERE state = 'verified' AND relation_type = 'successor';

CREATE TABLE knowledge_catalog_model_fact_audits (
  id INTEGER PRIMARY KEY,
  fact_id TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  related_product_id INTEGER,
  before_json TEXT,
  after_json TEXT,
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_model_fact_audits_product ON knowledge_catalog_model_fact_audits(product_id, id);
CREATE INDEX idx_model_fact_audits_related ON knowledge_catalog_model_fact_audits(related_product_id, id);
CREATE INDEX idx_model_fact_audits_fact ON knowledge_catalog_model_fact_audits(fact_id, id);

-- A view keeps the insert/update validation byte-identical. Recursion is capped even for bad imports.
CREATE VIEW knowledge_catalog_invalid_model_facts AS
SELECT f.id FROM knowledge_catalog_model_facts f
JOIN knowledge_catalog_products p ON p.id = f.product_id
LEFT JOIN knowledge_catalog_products target ON target.id = f.related_product_id
LEFT JOIN knowledge_catalog_model_families family ON family.id = f.family_id
LEFT JOIN knowledge_catalog_sources s ON s.id = f.source_id
WHERE f.state <> 'removed' AND (
  (f.relation_type = 'variant' AND f.product_id > f.related_product_id)
  OR (family.id IS NOT NULL AND family.manufacturer_id <> p.manufacturer_id)
  OR (target.id IS NOT NULL AND target.manufacturer_id <> p.manufacturer_id AND length(trim(f.manufacturer_justification)) < 10)
  OR ((SELECT COUNT(*) FROM (SELECT id FROM knowledge_catalog_model_facts x WHERE x.state <> 'removed' AND x.product_id = f.product_id LIMIT 41))
    + (SELECT COUNT(*) FROM (SELECT id FROM knowledge_catalog_model_facts x WHERE x.state <> 'removed' AND x.related_product_id = f.product_id LIMIT 41))) > 40
  OR (f.related_product_id IS NOT NULL AND ((SELECT COUNT(*) FROM (SELECT id FROM knowledge_catalog_model_facts x WHERE x.state <> 'removed' AND x.product_id = f.related_product_id LIMIT 41))
    + (SELECT COUNT(*) FROM (SELECT id FROM knowledge_catalog_model_facts x WHERE x.state <> 'removed' AND x.related_product_id = f.related_product_id LIMIT 41))) > 40)
  OR (f.family_id IS NOT NULL AND (SELECT COUNT(*) FROM (SELECT id FROM knowledge_catalog_model_facts x WHERE x.family_id = f.family_id AND x.state <> 'removed' LIMIT 41)) > 40)
  OR (f.state = 'verified' AND (
    p.verification_status <> 'verified' OR (target.id IS NOT NULL AND target.verification_status <> 'verified')
    OR f.verified_at IS NULL OR f.review_due_at IS NULL
    OR (f.evidence_kind = 'manual' AND length(trim(f.manual_note)) < 10)
    OR (f.evidence_kind = 'source' AND (s.id IS NULL OR s.status <> 'active'
      OR s.source_type NOT IN ('manufacturer_official', 'official_distributor', 'manufacturer_archive', 'manual_verified')
      OR (s.product_id <> f.product_id AND s.product_id IS NOT f.related_product_id)
      OR s.content_hash <> f.source_hash OR s.source_url <> f.source_url
      OR julianday(s.retrieved_at) IS NULL OR julianday(s.retrieved_at) < julianday(f.verified_at) - 180))
    OR (f.relation_type = 'successor' AND EXISTS (
      WITH RECURSIVE chain(product_id, depth) AS (
        SELECT f.related_product_id, 0
        UNION ALL
        SELECT x.related_product_id, chain.depth + 1 FROM chain
        JOIN knowledge_catalog_model_facts x ON x.product_id = chain.product_id
        WHERE x.state = 'verified' AND x.relation_type = 'successor' AND x.id <> f.id AND chain.depth < 100
      ) SELECT 1 FROM chain WHERE product_id = f.product_id OR depth = 100
    ))
  ))
);
CREATE TRIGGER model_fact_validate_insert AFTER INSERT ON knowledge_catalog_model_facts
BEGIN
  SELECT RAISE(ABORT, 'catalog_model_fact_invalid') WHERE EXISTS (SELECT 1 FROM knowledge_catalog_invalid_model_facts WHERE id = NEW.id);
END;

-- Active facts need an explicit review before a catalog merge/deletion. Removed facts may cascade;
-- their audit records deliberately have no catalog foreign key and remain available afterwards.
CREATE TRIGGER catalog_product_model_fact_guard BEFORE DELETE ON knowledge_catalog_products
BEGIN
  SELECT RAISE(ABORT, 'catalog_admin_model_facts_review_required') WHERE EXISTS (
    SELECT id FROM knowledge_catalog_model_facts WHERE product_id = OLD.id AND state <> 'removed'
    UNION ALL
    SELECT id FROM knowledge_catalog_model_facts WHERE related_product_id = OLD.id AND state <> 'removed'
  );
END;
CREATE TRIGGER model_fact_validate_update AFTER UPDATE ON knowledge_catalog_model_facts
BEGIN
  SELECT RAISE(ABORT, 'catalog_model_fact_invalid') WHERE EXISTS (SELECT 1 FROM knowledge_catalog_invalid_model_facts WHERE id = NEW.id);
END;
CREATE TRIGGER model_fact_audit_insert AFTER INSERT ON knowledge_catalog_model_facts
BEGIN
  INSERT INTO knowledge_catalog_model_fact_audits(fact_id, product_id, related_product_id, after_json, actor, occurred_at)
  VALUES(NEW.id, NEW.product_id, NEW.related_product_id,
    json_object('data',json(NEW.data_json),'sourceUrl',NEW.source_url,'sourceHash',NEW.source_hash,'version',NEW.version,'verifiedAt',NEW.verified_at,'reviewDueAt',NEW.review_due_at), NEW.audit_actor, NEW.updated_at);
END;
CREATE TRIGGER model_fact_audit_update AFTER UPDATE ON knowledge_catalog_model_facts
WHEN OLD.data_json IS NOT NEW.data_json OR OLD.verified_at IS NOT NEW.verified_at OR OLD.source_id IS NOT NEW.source_id OR OLD.source_hash IS NOT NEW.source_hash OR OLD.source_url IS NOT NEW.source_url OR OLD.version IS NOT NEW.version
BEGIN
  INSERT INTO knowledge_catalog_model_fact_audits(fact_id, product_id, related_product_id, before_json, after_json, actor, occurred_at)
  VALUES(NEW.id, NEW.product_id, NEW.related_product_id,
    json_object('data',json(OLD.data_json),'sourceUrl',OLD.source_url,'sourceHash',OLD.source_hash,'version',OLD.version,'verifiedAt',OLD.verified_at,'reviewDueAt',OLD.review_due_at),
    json_object('data',json(NEW.data_json),'sourceUrl',NEW.source_url,'sourceHash',NEW.source_hash,'version',NEW.version,'verifiedAt',NEW.verified_at,'reviewDueAt',NEW.review_due_at), NEW.audit_actor, NEW.updated_at);
END;
