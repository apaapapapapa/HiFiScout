-- The runtime searches product_search_entities_fts; the listing projection remains an input
-- to entity search evidence, but its obsolete parallel FTS index has no runtime readers.
DROP TRIGGER IF EXISTS product_search_projection_ai;
DROP TRIGGER IF EXISTS product_search_projection_ad;
DROP TRIGGER IF EXISTS product_search_projection_au;
DROP TABLE IF EXISTS product_search_fts;

-- UPDATE OF fires for named columns even when their values have not changed (e.g. price-only
-- crawler updates). Preserve enriched projection evidence and avoid writes in that case.
DROP TRIGGER IF EXISTS products_search_projection_au;
CREATE TRIGGER IF NOT EXISTS products_search_projection_au
AFTER UPDATE OF manufacturer, raw_manufacturer, manufacturer_id, model, title, category, raw_category, search_aliases ON products
WHEN old.manufacturer IS NOT new.manufacturer
  OR old.raw_manufacturer IS NOT new.raw_manufacturer
  OR old.manufacturer_id IS NOT new.manufacturer_id
  OR old.model IS NOT new.model
  OR old.title IS NOT new.title
  OR old.category IS NOT new.category
  OR old.raw_category IS NOT new.raw_category
  OR old.search_aliases IS NOT new.search_aliases
BEGIN
  INSERT INTO product_search_projection(
    product_id, manufacturer_id, source_model, normalized_model,
    manufacturer_terms, model_terms, title, category_terms
  ) VALUES (
    new.id,
    COALESCE(new.manufacturer_id, ''),
    COALESCE(new.model, ''),
    UPPER(REPLACE(REPLACE(REPLACE(COALESCE(new.model, ''), ' ', ''), '-', ''), '_', '')),
    TRIM(COALESCE(new.manufacturer, '') || ' ' || COALESCE(new.raw_manufacturer, '') || ' ' || COALESCE(new.manufacturer_id, '')),
    COALESCE(new.model, ''),
    COALESCE(new.title, ''),
    TRIM(COALESCE(new.category, '') || ' ' || COALESCE(new.raw_category, '') || ' ' || COALESCE(new.search_aliases, ''))
  )
  ON CONFLICT(product_id) DO UPDATE SET
    manufacturer_id = excluded.manufacturer_id,
    source_model = excluded.source_model,
    normalized_model = CASE
      WHEN product_search_projection.source_model IS NOT excluded.source_model
        OR product_search_projection.manufacturer_id IS NOT excluded.manufacturer_id
      THEN excluded.normalized_model ELSE product_search_projection.normalized_model END,
    manufacturer_terms = excluded.manufacturer_terms,
    model_terms = CASE
      WHEN product_search_projection.source_model IS NOT excluded.source_model
        OR product_search_projection.manufacturer_id IS NOT excluded.manufacturer_id
      THEN excluded.model_terms ELSE product_search_projection.model_terms END,
    title = excluded.title,
    category_terms = excluded.category_terms;
END;

-- Entity aggregates must not rewrite FTS when indexed text is unchanged.
DROP TRIGGER IF EXISTS product_search_entities_au;
CREATE TRIGGER IF NOT EXISTS product_search_entities_au
AFTER UPDATE OF manufacturer_terms, normalized_model, model_terms, title_terms, category_terms
ON product_search_entities
WHEN old.manufacturer_terms IS NOT new.manufacturer_terms
  OR old.normalized_model IS NOT new.normalized_model
  OR old.model_terms IS NOT new.model_terms
  OR old.title_terms IS NOT new.title_terms
  OR old.category_terms IS NOT new.category_terms
BEGIN
  INSERT INTO product_search_entities_fts(
    product_search_entities_fts, rowid, manufacturer_terms, normalized_model, model_terms, title_terms, category_terms
  ) VALUES (
    'delete', old.id, old.manufacturer_terms, old.normalized_model, old.model_terms, old.title_terms, old.category_terms
  );
  INSERT INTO product_search_entities_fts(
    rowid, manufacturer_terms, normalized_model, model_terms, title_terms, category_terms
  ) VALUES (
    new.id, new.manufacturer_terms, new.normalized_model, new.model_terms, new.title_terms, new.category_terms
  );
END;
