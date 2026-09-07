-- Persist only coarse duplicate-bucket members. Reads for admin navigation must never
-- aggregate the whole catalog. The TypeScript identity rule still decides true groups.
ALTER TABLE knowledge_catalog_products ADD COLUMN admin_identity_bucket TEXT
  GENERATED ALWAYS AS (REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(normalized_model), ' ', ''), '!', ''), '"', ''), '#', ''), '$', ''), '%', ''), '&', ''), '''', ''), '(', ''), ')', ''), '*', ''), '+', ''), ',', ''), '-', ''), '.', ''), '/', ''), ':', ''), ';', ''), '<', ''), '=', ''), '>', ''), '?', ''), '@', ''), '[', ''), '\', ''), ']', ''), '^', ''), '_', ''), '`', ''), '{', ''), '|', ''), '}', ''), '~', ''), 'EDITION', ''), 'MARK', 'MK'), 'MK4', 'MKIV'), 'MK3', 'MKIII'), 'MK2', 'MKII'), 'MK1', 'MKI'), 'REV4', 'IV'), 'REV3', 'III'), 'REV2', 'II')) VIRTUAL;
CREATE INDEX idx_catalog_admin_duplicate_bucket
  ON knowledge_catalog_products(admin_identity_bucket, id) WHERE verification_status = 'verified';

CREATE TABLE knowledge_catalog_duplicate_members (
  bucket_key TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES knowledge_catalog_products(id) ON DELETE CASCADE,
  PRIMARY KEY (bucket_key, product_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_catalog_duplicate_member_product
  ON knowledge_catalog_duplicate_members(product_id);

-- One-time backfill. Every subsequent write examines only its indexed bucket.
INSERT INTO knowledge_catalog_duplicate_members(bucket_key, product_id)
SELECT kp.admin_identity_bucket, kp.id FROM knowledge_catalog_products kp
WHERE kp.verification_status = 'verified' AND kp.admin_identity_bucket <> ''
  AND EXISTS (
    SELECT 1 FROM knowledge_catalog_products peer
    WHERE peer.verification_status = 'verified'
      AND peer.admin_identity_bucket = kp.admin_identity_bucket AND peer.id <> kp.id
  );

CREATE TRIGGER catalog_duplicate_member_insert AFTER INSERT ON knowledge_catalog_products
WHEN NEW.verification_status = 'verified' AND NEW.admin_identity_bucket <> ''
BEGIN
  -- At the singleton -> pair transition, retain the existing peer once.
  INSERT INTO knowledge_catalog_duplicate_members(bucket_key, product_id)
  SELECT NEW.admin_identity_bucket, kp.id
  FROM knowledge_catalog_products kp
  WHERE kp.verification_status = 'verified'
    AND kp.admin_identity_bucket = (
      SELECT NEW.admin_identity_bucket WHERE NOT EXISTS (
        SELECT 1 FROM knowledge_catalog_duplicate_members
        WHERE bucket_key = NEW.admin_identity_bucket
      )
    ) AND kp.id <> NEW.id
  LIMIT 1;
  INSERT INTO knowledge_catalog_duplicate_members(bucket_key, product_id)
  SELECT NEW.admin_identity_bucket, NEW.id
  WHERE EXISTS (
    SELECT 1 FROM knowledge_catalog_duplicate_members
    WHERE bucket_key = NEW.admin_identity_bucket
  );
END;

CREATE TRIGGER catalog_duplicate_member_delete AFTER DELETE ON knowledge_catalog_products
WHEN OLD.verification_status = 'verified' AND OLD.admin_identity_bucket <> ''
BEGIN
  DELETE FROM knowledge_catalog_duplicate_members
  WHERE bucket_key = (
    SELECT OLD.admin_identity_bucket WHERE NOT EXISTS (
      SELECT 1 FROM knowledge_catalog_products
      WHERE verification_status = 'verified' AND admin_identity_bucket = OLD.admin_identity_bucket
      LIMIT 1 OFFSET 1
    )
  );
END;

CREATE TRIGGER catalog_duplicate_member_update
AFTER UPDATE OF normalized_model, verification_status ON knowledge_catalog_products
WHEN OLD.admin_identity_bucket IS NOT NEW.admin_identity_bucket
  OR OLD.verification_status IS NOT NEW.verification_status
BEGIN
  DELETE FROM knowledge_catalog_duplicate_members WHERE product_id = OLD.id;

  DELETE FROM knowledge_catalog_duplicate_members
  WHERE bucket_key = (
    SELECT OLD.admin_identity_bucket WHERE NOT EXISTS (
      SELECT 1 FROM knowledge_catalog_products
      WHERE verification_status = 'verified' AND admin_identity_bucket = OLD.admin_identity_bucket
      LIMIT 1 OFFSET 1
    )
  );

  -- At the singleton -> pair transition, retain the existing peer once.
  INSERT INTO knowledge_catalog_duplicate_members(bucket_key, product_id)
  SELECT NEW.admin_identity_bucket, kp.id
  FROM knowledge_catalog_products kp
  WHERE NEW.verification_status = 'verified' AND NEW.admin_identity_bucket <> ''
    AND kp.verification_status = 'verified'
    AND kp.admin_identity_bucket = (
      SELECT NEW.admin_identity_bucket WHERE NOT EXISTS (
        SELECT 1 FROM knowledge_catalog_duplicate_members
        WHERE bucket_key = NEW.admin_identity_bucket
      )
    ) AND kp.id <> NEW.id
  LIMIT 1;
  INSERT INTO knowledge_catalog_duplicate_members(bucket_key, product_id)
  SELECT NEW.admin_identity_bucket, NEW.id
  WHERE NEW.verification_status = 'verified' AND NEW.admin_identity_bucket <> ''
    AND EXISTS (
    SELECT 1 FROM knowledge_catalog_duplicate_members
    WHERE bucket_key = NEW.admin_identity_bucket
  );
END;
