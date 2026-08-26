-- A listing is one sale, not necessarily one product.
--
-- `products.category_ids` keeps its existing meaning — the single-product classification result —
-- and `direct_category_ids` records the categories of the distinct products a listing contains.
-- For every listing that sells one product the two hold the same single category, which is why the
-- backfill below can derive the new column from the primary without inspecting any seller text.
ALTER TABLE products ADD COLUMN direct_category_ids TEXT;

UPDATE products
SET direct_category_ids = json_array(primary_category_id)
WHERE direct_category_ids IS NULL;

-- `product_categories` stays what it has been since 0013: the closure a category filter matches.
-- `is_direct` separates the categories a listing's products actually belong to from the ancestors
-- that exist only so a parent-category filter matches — a distinction a set needs and a
-- single-leaf closure never had to make.
ALTER TABLE product_categories ADD COLUMN is_direct INTEGER NOT NULL DEFAULT 0;

UPDATE product_categories
SET is_direct = 1
WHERE category_id = (
  SELECT p.primary_category_id FROM products p WHERE p.id = product_categories.product_id
);

CREATE INDEX IF NOT EXISTS idx_product_categories_direct
  ON product_categories(category_id, product_id)
  WHERE is_direct = 1;
