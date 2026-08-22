-- Persistent operator corrections for seller listings.
--
-- Seller evidence stays in raw_* fields. These overrides control only the canonical/effective
-- fields used by search and Product Identity, and are re-applied after every crawler write so a
-- verified admin correction does not disappear on the next crawl.
CREATE TABLE IF NOT EXISTS product_admin_overrides (
  listing_product_id INTEGER PRIMARY KEY,
  manufacturer_id TEXT,
  manufacturer_name TEXT,
  model TEXT,
  normalized_model TEXT,
  primary_category_id TEXT,
  category_ids TEXT CHECK (category_ids IS NULL OR json_valid(category_ids)),
  category_name TEXT,
  search_aliases TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(listing_product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_admin_overrides_manufacturer
  ON product_admin_overrides(manufacturer_id, listing_product_id)
  WHERE manufacturer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_admin_overrides_category
  ON product_admin_overrides(primary_category_id, listing_product_id)
  WHERE primary_category_id IS NOT NULL;

-- The crawler owns raw evidence but an explicit admin correction owns the corresponding canonical
-- fields. This trigger runs before downstream search/identity projection in the crawl path, so all
-- read models observe the corrected values. The difference guard also makes it safe if recursive
-- triggers are enabled.
CREATE TRIGGER IF NOT EXISTS product_admin_overrides_products_au
AFTER UPDATE OF
  manufacturer, manufacturer_id, canonical_manufacturer_id,
  manufacturer_resolution_status, manufacturer_resolution_method,
  manufacturer_resolution_confidence,
  model, normalized_model, model_resolution_status, model_resolution_method,
  model_resolution_confidence,
  category, primary_category_id, category_ids, classification_status, search_aliases
ON products
WHEN EXISTS (
  SELECT 1
  FROM product_admin_overrides o
  WHERE o.listing_product_id = NEW.id
    AND (
      (o.manufacturer_id IS NOT NULL AND (
        NEW.manufacturer IS NOT COALESCE(o.manufacturer_name, '') OR
        NEW.manufacturer_id IS NOT o.manufacturer_id OR
        NEW.canonical_manufacturer_id IS NOT o.manufacturer_id OR
        NEW.manufacturer_resolution_status IS NOT CASE WHEN o.manufacturer_id = '' THEN 'unresolved' ELSE 'resolved' END OR
        NEW.manufacturer_resolution_method IS NOT CASE WHEN o.manufacturer_id = '' THEN 'none' ELSE 'verified_alias' END OR
        NEW.manufacturer_resolution_confidence IS NOT CASE WHEN o.manufacturer_id = '' THEN 'none' ELSE 'high' END
      )) OR
      (o.model IS NOT NULL AND (
        NEW.model IS NOT o.model OR
        NEW.normalized_model IS NOT COALESCE(o.normalized_model, '') OR
        NEW.model_resolution_status IS NOT CASE WHEN o.model = '' THEN 'unresolved' ELSE 'resolved' END OR
        NEW.model_resolution_method IS NOT CASE WHEN o.model = '' THEN 'none' ELSE 'seller_model_annotated' END OR
        NEW.model_resolution_confidence IS NOT CASE WHEN o.model = '' THEN 'none' ELSE 'high' END
      )) OR
      (o.primary_category_id IS NOT NULL AND (
        NEW.category IS NOT COALESCE(o.category_name, '') OR
        NEW.primary_category_id IS NOT o.primary_category_id OR
        NEW.category_ids IS NOT json_array(o.primary_category_id) OR
        NEW.classification_status IS NOT 'classified' OR
        NEW.search_aliases IS NOT COALESCE(o.search_aliases, '')
      ))
    )
)
BEGIN
  UPDATE products
  SET manufacturer = CASE
        WHEN (SELECT manufacturer_id FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NOT NULL
        THEN COALESCE((SELECT manufacturer_name FROM product_admin_overrides WHERE listing_product_id = NEW.id), '')
        ELSE manufacturer
      END,
      manufacturer_id = CASE
        WHEN (SELECT manufacturer_id FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NOT NULL
        THEN (SELECT manufacturer_id FROM product_admin_overrides WHERE listing_product_id = NEW.id)
        ELSE manufacturer_id
      END,
      canonical_manufacturer_id = CASE
        WHEN (SELECT manufacturer_id FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NOT NULL
        THEN (SELECT manufacturer_id FROM product_admin_overrides WHERE listing_product_id = NEW.id)
        ELSE canonical_manufacturer_id
      END,
      manufacturer_resolution_status = CASE
        WHEN (SELECT manufacturer_id FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NULL
        THEN manufacturer_resolution_status
        WHEN (SELECT manufacturer_id FROM product_admin_overrides WHERE listing_product_id = NEW.id) = ''
        THEN 'unresolved'
        ELSE 'resolved'
      END,
      manufacturer_resolution_method = CASE
        WHEN (SELECT manufacturer_id FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NULL
        THEN manufacturer_resolution_method
        WHEN (SELECT manufacturer_id FROM product_admin_overrides WHERE listing_product_id = NEW.id) = ''
        THEN 'none'
        ELSE 'verified_alias'
      END,
      manufacturer_resolution_confidence = CASE
        WHEN (SELECT manufacturer_id FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NULL
        THEN manufacturer_resolution_confidence
        WHEN (SELECT manufacturer_id FROM product_admin_overrides WHERE listing_product_id = NEW.id) = ''
        THEN 'none'
        ELSE 'high'
      END,
      model = CASE
        WHEN (SELECT model FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NOT NULL
        THEN (SELECT model FROM product_admin_overrides WHERE listing_product_id = NEW.id)
        ELSE model
      END,
      normalized_model = CASE
        WHEN (SELECT model FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NOT NULL
        THEN COALESCE((SELECT normalized_model FROM product_admin_overrides WHERE listing_product_id = NEW.id), '')
        ELSE normalized_model
      END,
      model_resolution_status = CASE
        WHEN (SELECT model FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NULL
        THEN model_resolution_status
        WHEN (SELECT model FROM product_admin_overrides WHERE listing_product_id = NEW.id) = ''
        THEN 'unresolved'
        ELSE 'resolved'
      END,
      model_resolution_method = CASE
        WHEN (SELECT model FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NULL
        THEN model_resolution_method
        WHEN (SELECT model FROM product_admin_overrides WHERE listing_product_id = NEW.id) = ''
        THEN 'none'
        ELSE 'seller_model_annotated'
      END,
      model_resolution_confidence = CASE
        WHEN (SELECT model FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NULL
        THEN model_resolution_confidence
        WHEN (SELECT model FROM product_admin_overrides WHERE listing_product_id = NEW.id) = ''
        THEN 'none'
        ELSE 'high'
      END,
      category = CASE
        WHEN (SELECT primary_category_id FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NOT NULL
        THEN COALESCE((SELECT category_name FROM product_admin_overrides WHERE listing_product_id = NEW.id), '')
        ELSE category
      END,
      primary_category_id = CASE
        WHEN (SELECT primary_category_id FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NOT NULL
        THEN (SELECT primary_category_id FROM product_admin_overrides WHERE listing_product_id = NEW.id)
        ELSE primary_category_id
      END,
      category_ids = CASE
        WHEN (SELECT primary_category_id FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NOT NULL
        THEN json_array((SELECT primary_category_id FROM product_admin_overrides WHERE listing_product_id = NEW.id))
        ELSE category_ids
      END,
      classification_status = CASE
        WHEN (SELECT primary_category_id FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NOT NULL
        THEN 'classified'
        ELSE classification_status
      END,
      search_aliases = CASE
        WHEN (SELECT primary_category_id FROM product_admin_overrides WHERE listing_product_id = NEW.id) IS NOT NULL
        THEN COALESCE((SELECT search_aliases FROM product_admin_overrides WHERE listing_product_id = NEW.id), '')
        ELSE search_aliases
      END
  WHERE id = NEW.id;
END;

-- product_categories is maintained separately from products. Keep the manually selected category
-- closure authoritative while an override exists; the admin write path temporarily removes the
-- override row when changing the category, so it can replace this set deliberately.
CREATE TRIGGER IF NOT EXISTS product_admin_overrides_categories_bd
BEFORE DELETE ON product_categories
WHEN EXISTS (
  SELECT 1 FROM product_admin_overrides o
  WHERE o.listing_product_id = OLD.product_id AND o.primary_category_id IS NOT NULL
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER IF NOT EXISTS product_admin_overrides_categories_bi
BEFORE INSERT ON product_categories
WHEN EXISTS (
  SELECT 1
  FROM product_admin_overrides o
  WHERE o.listing_product_id = NEW.product_id
    AND o.primary_category_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM json_each(o.category_ids) WHERE value = NEW.category_id
    )
)
BEGIN
  SELECT RAISE(IGNORE);
END;
