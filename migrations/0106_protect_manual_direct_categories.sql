-- Category overrides already protect the primary category and product_categories membership.
-- Protect the later-added direct-category projection too, including direct-only crawl/replay
-- writes. No backfill or catalog-wide replay: the guard runs only for a changed listing.
CREATE TRIGGER product_admin_overrides_direct_categories_au
AFTER UPDATE OF primary_category_id, direct_category_ids ON products
WHEN EXISTS (
  SELECT 1 FROM product_admin_overrides o
  WHERE o.listing_product_id = NEW.id
    AND o.primary_category_id IS NOT NULL
    AND NEW.direct_category_ids IS NOT json_array(o.primary_category_id)
)
BEGIN
  UPDATE products
  SET direct_category_ids = json_array((
    SELECT primary_category_id FROM product_admin_overrides WHERE listing_product_id = NEW.id
  ))
  WHERE id = NEW.id;
END;
