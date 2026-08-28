-- Step 5 of issue #342: persist the relative-price ranking on the search entity so
-- `?sort=dealScore` remains an ordinary indexed keyset sort instead of a request-time scan.
--
-- Negative basis points mean the currently actionable price is below the retained asking-price
-- median; positive values mean it is above. NULL deliberately means "insufficient/no index" and
-- sorts last. The threshold literal below is the immutable migration snapshot of
-- PRODUCT_PRICE_INDEX_MIN_ASKING_SAMPLES = 3 at rollout time; runtime policy remains centralised in
-- src/api/price-index.ts.

ALTER TABLE product_search_entities ADD COLUMN deal_score INTEGER;

CREATE INDEX IF NOT EXISTS idx_product_search_entities_deal_score
  ON product_search_entities(deal_score ASC, id ASC);

-- Existing rows become sortable immediately after the migration. Prefer the cheapest in-stock
-- offer; only fall back to another active offer when no in-stock price exists.
UPDATE product_search_entities AS e
SET deal_score = (
  SELECT CASE
    WHEN e.entity_kind = 'catalog'
      AND e.catalog_product_id IS NOT NULL
      AND i.asking_sample_count >= 3
      AND i.asking_median_yen IS NOT NULL
      AND i.asking_median_yen > 0
      AND COALESCE(e.lowest_in_stock_price_yen, e.lowest_price_yen) IS NOT NULL
    THEN CAST(ROUND(
      (COALESCE(e.lowest_in_stock_price_yen, e.lowest_price_yen) - i.asking_median_yen)
      * 10000.0 / i.asking_median_yen
    ) AS INTEGER)
    ELSE NULL
  END
  FROM knowledge_catalog_price_indexes i
  WHERE i.catalog_product_id = e.catalog_product_id
);

-- A newly materialised entity may initially have no offer aggregates; the aggregate UPDATE below
-- will run the update trigger once its prices are projected.
CREATE TRIGGER IF NOT EXISTS product_search_entities_deal_score_ai
AFTER INSERT ON product_search_entities BEGIN
  UPDATE product_search_entities
  SET deal_score = (
    SELECT CASE
      WHEN NEW.entity_kind = 'catalog'
        AND NEW.catalog_product_id IS NOT NULL
        AND i.asking_sample_count >= 3
        AND i.asking_median_yen IS NOT NULL
        AND i.asking_median_yen > 0
        AND COALESCE(NEW.lowest_in_stock_price_yen, NEW.lowest_price_yen) IS NOT NULL
      THEN CAST(ROUND(
        (COALESCE(NEW.lowest_in_stock_price_yen, NEW.lowest_price_yen) - i.asking_median_yen)
        * 10000.0 / i.asking_median_yen
      ) AS INTEGER)
      ELSE NULL
    END
    FROM knowledge_catalog_price_indexes i
    WHERE i.catalog_product_id = NEW.catalog_product_id
  )
  WHERE id = NEW.id;
END;

-- Price projection and late identity changes are the entity-side inputs to the score. Restricting
-- the trigger to those columns prevents the UPDATE of deal_score itself from recursing.
CREATE TRIGGER IF NOT EXISTS product_search_entities_deal_score_au
AFTER UPDATE OF entity_kind, catalog_product_id, lowest_price_yen, lowest_in_stock_price_yen
ON product_search_entities BEGIN
  UPDATE product_search_entities
  SET deal_score = (
    SELECT CASE
      WHEN NEW.entity_kind = 'catalog'
        AND NEW.catalog_product_id IS NOT NULL
        AND i.asking_sample_count >= 3
        AND i.asking_median_yen IS NOT NULL
        AND i.asking_median_yen > 0
        AND COALESCE(NEW.lowest_in_stock_price_yen, NEW.lowest_price_yen) IS NOT NULL
      THEN CAST(ROUND(
        (COALESCE(NEW.lowest_in_stock_price_yen, NEW.lowest_price_yen) - i.asking_median_yen)
        * 10000.0 / i.asking_median_yen
      ) AS INTEGER)
      ELSE NULL
    END
    FROM knowledge_catalog_price_indexes i
    WHERE i.catalog_product_id = NEW.catalog_product_id
  )
  WHERE id = NEW.id;
END;

-- Index maintenance/backfill changes the denominator. Refresh every live search entity attached to
-- that catalog product without touching unrelated rows.
CREATE TRIGGER IF NOT EXISTS knowledge_catalog_price_indexes_deal_score_ai
AFTER INSERT ON knowledge_catalog_price_indexes BEGIN
  UPDATE product_search_entities
  SET deal_score = CASE
    WHEN entity_kind = 'catalog'
      AND NEW.asking_sample_count >= 3
      AND NEW.asking_median_yen IS NOT NULL
      AND NEW.asking_median_yen > 0
      AND COALESCE(lowest_in_stock_price_yen, lowest_price_yen) IS NOT NULL
    THEN CAST(ROUND(
      (COALESCE(lowest_in_stock_price_yen, lowest_price_yen) - NEW.asking_median_yen)
      * 10000.0 / NEW.asking_median_yen
    ) AS INTEGER)
    ELSE NULL
  END
  WHERE catalog_product_id = NEW.catalog_product_id;
END;

CREATE TRIGGER IF NOT EXISTS knowledge_catalog_price_indexes_deal_score_au
AFTER UPDATE OF asking_sample_count, asking_median_yen ON knowledge_catalog_price_indexes BEGIN
  UPDATE product_search_entities
  SET deal_score = CASE
    WHEN entity_kind = 'catalog'
      AND NEW.asking_sample_count >= 3
      AND NEW.asking_median_yen IS NOT NULL
      AND NEW.asking_median_yen > 0
      AND COALESCE(lowest_in_stock_price_yen, lowest_price_yen) IS NOT NULL
    THEN CAST(ROUND(
      (COALESCE(lowest_in_stock_price_yen, lowest_price_yen) - NEW.asking_median_yen)
      * 10000.0 / NEW.asking_median_yen
    ) AS INTEGER)
    ELSE NULL
  END
  WHERE catalog_product_id = NEW.catalog_product_id;
END;

CREATE TRIGGER IF NOT EXISTS knowledge_catalog_price_indexes_deal_score_ad
AFTER DELETE ON knowledge_catalog_price_indexes BEGIN
  UPDATE product_search_entities
  SET deal_score = NULL
  WHERE catalog_product_id = OLD.catalog_product_id;
END;
