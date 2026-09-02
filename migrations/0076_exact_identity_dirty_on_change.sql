-- Mark an identity dirty when it actually changes, not when a listing is merely rewritten.
--
-- SQLite's `AFTER UPDATE OF <columns>` fires on assignment, not on difference: a column named in the
-- SET list fires the trigger even when the value written equals the value already stored. The crawl
-- write path in `product-write-repository.ts` sets every column of a changed listing in one
-- statement -- including all five columns 0074 watches, `is_active = 1` among them -- so any listing
-- whose price or stock moved was marking its identity dirty even though nothing about its grouping
-- or eligibility had changed.
--
-- That is safe but it contradicts the property the dirty set exists to provide. The cost was meant
-- to track the identities that changed; instead it tracked the listings that changed, which is a
-- much larger and much less meaningful set. At current production scale (3,677 active resolved
-- listings over 2,475 identities, against a drain of 25 identities per five-minute tick) the queue
-- still drains comfortably either way, so this is not a correctness or capacity fix -- it is making
-- the implementation mean what the design says.
--
-- `IS NOT` rather than `<>` because it is null-safe: `<>` yields NULL against a NULL operand, and a
-- WHEN clause that evaluates to NULL does not fire, which would silently drop exactly the transition
-- a nullable column is most likely to make.
--
-- Only the update trigger changes. Insert, delete, resolution and catalog-verification triggers are
-- already change-driven by construction: a row appearing or disappearing is itself the change.

DROP TRIGGER IF EXISTS trg_exact_identity_dirty_product_update;

CREATE TRIGGER trg_exact_identity_dirty_product_update
AFTER UPDATE OF
  canonical_manufacturer_id, normalized_model, is_active, model_resolution_status, primary_category_id
ON products
WHEN OLD.canonical_manufacturer_id IS NOT NEW.canonical_manufacturer_id
  OR OLD.normalized_model IS NOT NEW.normalized_model
  OR OLD.is_active IS NOT NEW.is_active
  OR OLD.model_resolution_status IS NOT NEW.model_resolution_status
  OR OLD.primary_category_id IS NOT NEW.primary_category_id
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
