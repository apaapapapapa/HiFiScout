-- Extend persistent operator corrections to the listing presentation colour introduced in 0050.
--
-- NULL means the crawler-owned normalized colour remains authoritative. A non-NULL value (including
-- the empty string) is an explicit operator override and is re-applied after subsequent crawler
-- writes so an admin correction cannot disappear on refresh.
ALTER TABLE product_admin_overrides
  ADD COLUMN presentation_color TEXT;

CREATE TRIGGER IF NOT EXISTS product_admin_overrides_presentation_color_au
AFTER UPDATE OF presentation_color ON products
WHEN EXISTS (
  SELECT 1
  FROM product_admin_overrides o
  WHERE o.listing_product_id = NEW.id
    AND o.presentation_color IS NOT NULL
    AND NEW.presentation_color IS NOT o.presentation_color
)
BEGIN
  UPDATE products
  SET presentation_color = (
    SELECT o.presentation_color
    FROM product_admin_overrides o
    WHERE o.listing_product_id = NEW.id
  )
  WHERE id = NEW.id;
END;
