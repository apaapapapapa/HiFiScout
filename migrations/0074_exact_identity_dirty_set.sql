-- Turn exact-identity split repair from an O(active listings) scan into O(changed identities).
--
-- `exactIdentitySplitMembershipPredicateSql` answers "is this listing's identity group split across
-- search entities?" with correlated subqueries that join `products` to itself on identity. There is
-- no index that answers it, so the hourly repair pays for it across every active listing even when
-- nothing has drifted -- and the drift it finds is usually nothing. Migration 0036 hit the same wall
-- from the other direction: expressing representative/category checks as correlated subqueries per
-- product exceeded D1's per-query CPU budget, and had to be staged through materialized helpers.
--
-- The unit of dirt here is the IDENTITY, not the listing. That choice is what keeps this cheap and
-- correct at the same time:
--
--   * peers need no discovery. A split is a property of an identity group, and every member shares
--     the identity, so marking the identity marks the whole group. A listing-keyed dirty set would
--     have to run the very self-join this exists to avoid just to find the peers to mark.
--   * a listing that LEAVES an identity can strand the peers it leaves behind, so an update marks
--     the old identity as well as the new one. Both are available on the trigger row -- still no
--     join.
--   * repeated writes to one identity collapse onto one row, so a busy crawl cannot amplify the
--     backlog beyond the number of distinct identities it actually touched.
--
-- `marked_at` is preserved across re-marks so the oldest outstanding identity stays at the front of
-- the queue; a repeatedly-rewritten identity cannot push itself behind quieter work. Re-marking does
-- clear `claimed_at`, so an identity that changes while a repair is in flight is repaired again
-- rather than being deleted as clean -- see the claim-token delete in the repair repository.
--
-- The legacy full scan is deliberately left in place as a correctness safety net. Anything it still
-- repairs is a hole in the trigger coverage below, and is logged as such.

CREATE TABLE IF NOT EXISTS product_search_exact_identity_dirty (
  canonical_manufacturer_id TEXT NOT NULL,
  normalized_model TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  -- NULL when queued. Set to the claiming pass's timestamp, which doubles as the token that makes
  -- the clearing delete safe against an identity re-dirtied mid-repair.
  claimed_at TEXT,
  PRIMARY KEY (canonical_manufacturer_id, normalized_model)
);

-- Claim order: unclaimed first, oldest mark first.
CREATE INDEX IF NOT EXISTS idx_exact_identity_dirty_queue
  ON product_search_exact_identity_dirty(claimed_at, marked_at);

-- The repair resolves one identity to its listings, and this is the index that makes that a bounded
-- search rather than the scan it replaces.
--
-- The eligibility columns are part of the key for a planner reason, not a covering one. With only
-- the two identity columns indexed, SQLite preferred the existing
-- `idx_products_model_resolution(model_resolution_status, is_active)` for this lookup -- two
-- equality terms either way, and it has no statistics to tell it that one identity is a handful of
-- rows while `resolved AND active` is most of the catalog. Choosing that index would have put the
-- O(N) cost straight back. Carrying all four equality terms makes this index unambiguously the
-- better one, so the access path stops depending on a guess.
CREATE INDEX IF NOT EXISTS idx_products_exact_identity
  ON products(canonical_manufacturer_id, normalized_model, is_active, model_resolution_status);

-- Reaching a verified catalog product's matched listings is already indexed: 0017's partial
-- `idx_product_identity_catalog` covers `catalog_product_id IS NOT NULL`, and the trigger below
-- always binds a concrete id, so it qualifies. Adding a second, non-partial index on the same column
-- would be redundant and actively harmful -- it displaced the partial one in the planner's choice
-- for the catalog export scan, which the export query-plan test caught.

DROP TRIGGER IF EXISTS trg_exact_identity_dirty_product_insert;
DROP TRIGGER IF EXISTS trg_exact_identity_dirty_product_update;
DROP TRIGGER IF EXISTS trg_exact_identity_dirty_product_delete;
DROP TRIGGER IF EXISTS trg_exact_identity_dirty_resolution_insert;
DROP TRIGGER IF EXISTS trg_exact_identity_dirty_resolution_update;
DROP TRIGGER IF EXISTS trg_exact_identity_dirty_resolution_delete;
DROP TRIGGER IF EXISTS trg_exact_identity_dirty_catalog_verification;

CREATE TRIGGER trg_exact_identity_dirty_product_insert
AFTER INSERT ON products
WHEN COALESCE(NEW.canonical_manufacturer_id, '') <> ''
  AND COALESCE(NEW.normalized_model, '') <> ''
BEGIN
  INSERT INTO product_search_exact_identity_dirty(
    canonical_manufacturer_id, normalized_model, marked_at
  )
  VALUES (
    NEW.canonical_manufacturer_id,
    NEW.normalized_model,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT(canonical_manufacturer_id, normalized_model) DO UPDATE SET claimed_at = NULL;
END;

-- Every column the eligibility predicate reads. `is_active`, `model_resolution_status` and
-- `primary_category_id` do not change the identity key but do change who belongs to the group and
-- whether the group's categories still agree.
CREATE TRIGGER trg_exact_identity_dirty_product_update
AFTER UPDATE OF
  canonical_manufacturer_id, normalized_model, is_active, model_resolution_status, primary_category_id
ON products
BEGIN
  INSERT INTO product_search_exact_identity_dirty(
    canonical_manufacturer_id, normalized_model, marked_at
  )
  SELECT
    OLD.canonical_manufacturer_id,
    OLD.normalized_model,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE COALESCE(OLD.canonical_manufacturer_id, '') <> ''
    AND COALESCE(OLD.normalized_model, '') <> ''
  ON CONFLICT(canonical_manufacturer_id, normalized_model) DO UPDATE SET claimed_at = NULL;

  INSERT INTO product_search_exact_identity_dirty(
    canonical_manufacturer_id, normalized_model, marked_at
  )
  SELECT
    NEW.canonical_manufacturer_id,
    NEW.normalized_model,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE COALESCE(NEW.canonical_manufacturer_id, '') <> ''
    AND COALESCE(NEW.normalized_model, '') <> ''
  ON CONFLICT(canonical_manufacturer_id, normalized_model) DO UPDATE SET claimed_at = NULL;
END;

CREATE TRIGGER trg_exact_identity_dirty_product_delete
AFTER DELETE ON products
WHEN COALESCE(OLD.canonical_manufacturer_id, '') <> ''
  AND COALESCE(OLD.normalized_model, '') <> ''
BEGIN
  INSERT INTO product_search_exact_identity_dirty(
    canonical_manufacturer_id, normalized_model, marked_at
  )
  VALUES (
    OLD.canonical_manufacturer_id,
    OLD.normalized_model,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT(canonical_manufacturer_id, normalized_model) DO UPDATE SET claimed_at = NULL;
END;

-- A resolution row is what makes a listing a verified catalog match, and eligibility excludes those.
-- `listing_product_id` is the resolution table's primary key, so reaching the listing's identity is
-- a point lookup.
CREATE TRIGGER trg_exact_identity_dirty_resolution_insert
AFTER INSERT ON product_identity_resolutions
BEGIN
  INSERT INTO product_search_exact_identity_dirty(
    canonical_manufacturer_id, normalized_model, marked_at
  )
  SELECT
    p.canonical_manufacturer_id,
    p.normalized_model,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM products p
  WHERE p.id = NEW.listing_product_id
    AND COALESCE(p.canonical_manufacturer_id, '') <> ''
    AND COALESCE(p.normalized_model, '') <> ''
  ON CONFLICT(canonical_manufacturer_id, normalized_model) DO UPDATE SET claimed_at = NULL;
END;

CREATE TRIGGER trg_exact_identity_dirty_resolution_update
AFTER UPDATE OF catalog_product_id, status ON product_identity_resolutions
BEGIN
  INSERT INTO product_search_exact_identity_dirty(
    canonical_manufacturer_id, normalized_model, marked_at
  )
  SELECT
    p.canonical_manufacturer_id,
    p.normalized_model,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM products p
  WHERE p.id = NEW.listing_product_id
    AND COALESCE(p.canonical_manufacturer_id, '') <> ''
    AND COALESCE(p.normalized_model, '') <> ''
  ON CONFLICT(canonical_manufacturer_id, normalized_model) DO UPDATE SET claimed_at = NULL;
END;

CREATE TRIGGER trg_exact_identity_dirty_resolution_delete
AFTER DELETE ON product_identity_resolutions
BEGIN
  INSERT INTO product_search_exact_identity_dirty(
    canonical_manufacturer_id, normalized_model, marked_at
  )
  SELECT
    p.canonical_manufacturer_id,
    p.normalized_model,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM products p
  WHERE p.id = OLD.listing_product_id
    AND COALESCE(p.canonical_manufacturer_id, '') <> ''
    AND COALESCE(p.normalized_model, '') <> ''
  ON CONFLICT(canonical_manufacturer_id, normalized_model) DO UPDATE SET claimed_at = NULL;
END;

-- Verification flipping on the catalog side changes eligibility for every listing already matched to
-- that product, without any row on `products` or `product_identity_resolutions` being touched.
CREATE TRIGGER trg_exact_identity_dirty_catalog_verification
AFTER UPDATE OF verification_status ON knowledge_catalog_products
BEGIN
  INSERT INTO product_search_exact_identity_dirty(
    canonical_manufacturer_id, normalized_model, marked_at
  )
  SELECT DISTINCT
    p.canonical_manufacturer_id,
    p.normalized_model,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM product_identity_resolutions r
  JOIN products p ON p.id = r.listing_product_id
  WHERE r.catalog_product_id = NEW.id
    AND COALESCE(p.canonical_manufacturer_id, '') <> ''
    AND COALESCE(p.normalized_model, '') <> ''
  ON CONFLICT(canonical_manufacturer_id, normalized_model) DO UPDATE SET claimed_at = NULL;
END;
