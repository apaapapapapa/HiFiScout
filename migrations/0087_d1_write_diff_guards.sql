-- Avoid same-value score/index writes. Existing scores are already correct; no data backfill.
-- Runtime aggregates and price-index triggers can fire even when the computed score stays NULL.
DROP TRIGGER IF EXISTS product_search_entities_deal_score_ai;
CREATE TRIGGER product_search_entities_deal_score_ai
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
  WHERE id = NEW.id
    AND deal_score IS NOT (
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
  );
END;

-- Price projection and late identity changes are the entity-side inputs to the score. Restricting
-- the trigger to those columns prevents the UPDATE of deal_score itself from recursing.
DROP TRIGGER IF EXISTS product_search_entities_deal_score_au;
CREATE TRIGGER product_search_entities_deal_score_au
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
  WHERE id = NEW.id
    AND deal_score IS NOT (
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
  );
END;

-- Index maintenance/backfill changes the denominator. Refresh every live search entity attached to
-- that catalog product without touching unrelated rows.
DROP TRIGGER IF EXISTS knowledge_catalog_price_indexes_deal_score_ai;
CREATE TRIGGER knowledge_catalog_price_indexes_deal_score_ai
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
  WHERE catalog_product_id = NEW.catalog_product_id
    AND deal_score IS NOT CASE
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
  END;
END;

DROP TRIGGER IF EXISTS knowledge_catalog_price_indexes_deal_score_au;
CREATE TRIGGER knowledge_catalog_price_indexes_deal_score_au
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
  WHERE catalog_product_id = NEW.catalog_product_id
    AND deal_score IS NOT CASE
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
  END;
END;

DROP TRIGGER IF EXISTS knowledge_catalog_price_indexes_deal_score_ad;
CREATE TRIGGER knowledge_catalog_price_indexes_deal_score_ad
AFTER DELETE ON knowledge_catalog_price_indexes BEGIN
  UPDATE product_search_entities
  SET deal_score = NULL
  WHERE catalog_product_id = OLD.catalog_product_id
    AND deal_score IS NOT NULL;
END;
