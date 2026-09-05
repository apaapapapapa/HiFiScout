-- Expand only; existing aggregates are rebuilt by the admitted, cursor-based background job.
ALTER TABLE knowledge_catalog_price_indexes ADD COLUMN asking_listing_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_catalog_price_indexes ADD COLUMN asking_shop_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_catalog_price_indexes ADD COLUMN latest_asking_observed_at TEXT;
ALTER TABLE knowledge_catalog_price_indexes ADD COLUMN listing_basis_computed_at TEXT;
ALTER TABLE product_search_entities ADD COLUMN listing_deal_score INTEGER;
CREATE INDEX idx_product_search_entities_listing_deal_score ON product_search_entities(listing_deal_score ASC,id ASC);
DROP VIEW IF EXISTS knowledge_catalog_price_index_rollup;
CREATE VIEW knowledge_catalog_price_index_rollup(catalog_product_id,asking_sample_count,asking_median_yen,asking_min_yen,asking_max_yen,recent_asking_median_yen,listing_end_sample_count,listing_end_median_yen,sold_out_signal_count,deactivated_signal_count,last_computed_at,asking_listing_count,asking_shop_count,latest_asking_observed_at,listing_basis_computed_at) AS 
  WITH
  scoped AS MATERIALIZED (
    SELECT id, catalog_product_id, listing_product_id, shop_key, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE 1=1
  ),
  catalog_ids AS (
    SELECT DISTINCT catalog_product_id FROM scoped
  ),
  asking_latest AS MATERIALIZED (
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY catalog_product_id, listing_product_id
        ORDER BY julianday(observed_at) DESC, id DESC) AS observation_rank
      FROM scoped WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
    ) WHERE observation_rank = 1
  ),
  asking_observation_stats AS (
    SELECT catalog_product_id, COUNT(*) AS observation_count
    FROM scoped WHERE sample_kind = 'asking' AND price_yen IS NOT NULL GROUP BY catalog_product_id
  ),
  asking_context_stats AS (
    SELECT catalog_product_id, COUNT(DISTINCT shop_key) AS shop_count, MAX(observed_at) AS latest_observed_at
    FROM asking_latest GROUP BY catalog_product_id
  ),
  asking_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM asking_latest
    WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
  ),
  asking_stats AS (
    SELECT
      catalog_product_id,
      MAX(sample_count) AS asking_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS asking_median_yen,
      MIN(price_yen) AS asking_min_yen,
      MAX(price_yen) AS asking_max_yen
    FROM asking_ranked
    GROUP BY catalog_product_id
  ),
  recent_asking_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM asking_latest
    WHERE sample_kind = 'asking'
      AND price_yen IS NOT NULL
      AND julianday(observed_at) >= julianday(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days'))
  ),
  recent_asking_stats AS (
    SELECT
      catalog_product_id,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS recent_asking_median_yen
    FROM recent_asking_ranked
    GROUP BY catalog_product_id
  ),
  listing_end_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM scoped
    WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
  ),
  listing_end_stats AS (
    SELECT
      catalog_product_id,
      MAX(sample_count) AS listing_end_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS listing_end_median_yen
    FROM listing_end_ranked
    GROUP BY catalog_product_id
  ),
  signal_stats AS (
    SELECT
      catalog_product_id,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'sold_out' THEN 1
          ELSE 0
        END
      ) AS sold_out_signal_count,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'deactivated' THEN 1
          ELSE 0
        END
      ) AS deactivated_signal_count
    FROM scoped
    GROUP BY catalog_product_id
  )
  SELECT
    catalog_ids.catalog_product_id,
    COALESCE(asking_observation_stats.observation_count, 0),
    asking_stats.asking_median_yen,
    asking_stats.asking_min_yen,
    asking_stats.asking_max_yen,
    recent_asking_stats.recent_asking_median_yen,
    COALESCE(listing_end_stats.listing_end_sample_count, 0),
    listing_end_stats.listing_end_median_yen,
    COALESCE(signal_stats.sold_out_signal_count, 0),
    COALESCE(signal_stats.deactivated_signal_count, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    COALESCE(asking_stats.asking_sample_count, 0),
    COALESCE(asking_context_stats.shop_count, 0),
    asking_context_stats.latest_observed_at,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM catalog_ids
  LEFT JOIN asking_stats USING (catalog_product_id)
  LEFT JOIN asking_observation_stats USING (catalog_product_id)
  LEFT JOIN asking_context_stats USING (catalog_product_id)
  LEFT JOIN recent_asking_stats USING (catalog_product_id)
  LEFT JOIN listing_end_stats USING (catalog_product_id)
  LEFT JOIN signal_stats USING (catalog_product_id);

DROP TRIGGER IF EXISTS trg_price_index_sample_insert;
CREATE TRIGGER trg_price_index_sample_insert
AFTER INSERT
ON knowledge_catalog_price_index_samples
WHEN NOT EXISTS (SELECT 1 FROM knowledge_catalog_price_index_refresh_deferrals)
BEGIN
DELETE FROM knowledge_catalog_price_indexes WHERE catalog_product_id = NEW.catalog_product_id
AND NOT EXISTS(SELECT 1 FROM knowledge_catalog_price_index_samples WHERE catalog_product_id = NEW.catalog_product_id);
INSERT INTO knowledge_catalog_price_indexes(catalog_product_id,asking_sample_count,asking_median_yen,asking_min_yen,asking_max_yen,recent_asking_median_yen,listing_end_sample_count,listing_end_median_yen,sold_out_signal_count,deactivated_signal_count,last_computed_at,asking_listing_count,asking_shop_count,latest_asking_observed_at,listing_basis_computed_at)
    
  WITH
  scoped AS MATERIALIZED (
    SELECT id, catalog_product_id, listing_product_id, shop_key, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE catalog_product_id = NEW.catalog_product_id
  ),
  catalog_ids AS (
    SELECT DISTINCT catalog_product_id FROM scoped
  ),
  asking_latest AS MATERIALIZED (
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY catalog_product_id, listing_product_id
        ORDER BY julianday(observed_at) DESC, id DESC) AS observation_rank
      FROM scoped WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
    ) WHERE observation_rank = 1
  ),
  asking_observation_stats AS (
    SELECT catalog_product_id, COUNT(*) AS observation_count
    FROM scoped WHERE sample_kind = 'asking' AND price_yen IS NOT NULL GROUP BY catalog_product_id
  ),
  asking_context_stats AS (
    SELECT catalog_product_id, COUNT(DISTINCT shop_key) AS shop_count, MAX(observed_at) AS latest_observed_at
    FROM asking_latest GROUP BY catalog_product_id
  ),
  asking_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM asking_latest
    WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
  ),
  asking_stats AS (
    SELECT
      catalog_product_id,
      MAX(sample_count) AS asking_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS asking_median_yen,
      MIN(price_yen) AS asking_min_yen,
      MAX(price_yen) AS asking_max_yen
    FROM asking_ranked
    GROUP BY catalog_product_id
  ),
  recent_asking_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM asking_latest
    WHERE sample_kind = 'asking'
      AND price_yen IS NOT NULL
      AND julianday(observed_at) >= julianday(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days'))
  ),
  recent_asking_stats AS (
    SELECT
      catalog_product_id,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS recent_asking_median_yen
    FROM recent_asking_ranked
    GROUP BY catalog_product_id
  ),
  listing_end_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM scoped
    WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
  ),
  listing_end_stats AS (
    SELECT
      catalog_product_id,
      MAX(sample_count) AS listing_end_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS listing_end_median_yen
    FROM listing_end_ranked
    GROUP BY catalog_product_id
  ),
  signal_stats AS (
    SELECT
      catalog_product_id,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'sold_out' THEN 1
          ELSE 0
        END
      ) AS sold_out_signal_count,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'deactivated' THEN 1
          ELSE 0
        END
      ) AS deactivated_signal_count
    FROM scoped
    GROUP BY catalog_product_id
  )
  SELECT
    catalog_ids.catalog_product_id,
    COALESCE(asking_observation_stats.observation_count, 0),
    asking_stats.asking_median_yen,
    asking_stats.asking_min_yen,
    asking_stats.asking_max_yen,
    recent_asking_stats.recent_asking_median_yen,
    COALESCE(listing_end_stats.listing_end_sample_count, 0),
    listing_end_stats.listing_end_median_yen,
    COALESCE(signal_stats.sold_out_signal_count, 0),
    COALESCE(signal_stats.deactivated_signal_count, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    COALESCE(asking_stats.asking_sample_count, 0),
    COALESCE(asking_context_stats.shop_count, 0),
    asking_context_stats.latest_observed_at,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM catalog_ids
  LEFT JOIN asking_stats USING (catalog_product_id)
  LEFT JOIN asking_observation_stats USING (catalog_product_id)
  LEFT JOIN asking_context_stats USING (catalog_product_id)
  LEFT JOIN recent_asking_stats USING (catalog_product_id)
  LEFT JOIN listing_end_stats USING (catalog_product_id)
  LEFT JOIN signal_stats USING (catalog_product_id)
    ON CONFLICT(catalog_product_id) DO UPDATE SET
    asking_sample_count = excluded.asking_sample_count,asking_median_yen = excluded.asking_median_yen,asking_min_yen = excluded.asking_min_yen,asking_max_yen = excluded.asking_max_yen,recent_asking_median_yen = excluded.recent_asking_median_yen,listing_end_sample_count = excluded.listing_end_sample_count,listing_end_median_yen = excluded.listing_end_median_yen,sold_out_signal_count = excluded.sold_out_signal_count,deactivated_signal_count = excluded.deactivated_signal_count,last_computed_at = excluded.last_computed_at,asking_listing_count = excluded.asking_listing_count,asking_shop_count = excluded.asking_shop_count,latest_asking_observed_at = excluded.latest_asking_observed_at,listing_basis_computed_at = excluded.listing_basis_computed_at;
END;

DROP TRIGGER IF EXISTS trg_price_index_sample_update;
CREATE TRIGGER trg_price_index_sample_update
AFTER UPDATE OF catalog_product_id,listing_product_id,shop_key,sample_kind,signal_kind,price_yen,observed_at
ON knowledge_catalog_price_index_samples
WHEN NOT EXISTS (SELECT 1 FROM knowledge_catalog_price_index_refresh_deferrals)
BEGIN
DELETE FROM knowledge_catalog_price_indexes WHERE catalog_product_id = OLD.catalog_product_id
AND NOT EXISTS(SELECT 1 FROM knowledge_catalog_price_index_samples WHERE catalog_product_id = OLD.catalog_product_id);
INSERT INTO knowledge_catalog_price_indexes(catalog_product_id,asking_sample_count,asking_median_yen,asking_min_yen,asking_max_yen,recent_asking_median_yen,listing_end_sample_count,listing_end_median_yen,sold_out_signal_count,deactivated_signal_count,last_computed_at,asking_listing_count,asking_shop_count,latest_asking_observed_at,listing_basis_computed_at)
    
  WITH
  scoped AS MATERIALIZED (
    SELECT id, catalog_product_id, listing_product_id, shop_key, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE catalog_product_id = OLD.catalog_product_id
  ),
  catalog_ids AS (
    SELECT DISTINCT catalog_product_id FROM scoped
  ),
  asking_latest AS MATERIALIZED (
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY catalog_product_id, listing_product_id
        ORDER BY julianday(observed_at) DESC, id DESC) AS observation_rank
      FROM scoped WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
    ) WHERE observation_rank = 1
  ),
  asking_observation_stats AS (
    SELECT catalog_product_id, COUNT(*) AS observation_count
    FROM scoped WHERE sample_kind = 'asking' AND price_yen IS NOT NULL GROUP BY catalog_product_id
  ),
  asking_context_stats AS (
    SELECT catalog_product_id, COUNT(DISTINCT shop_key) AS shop_count, MAX(observed_at) AS latest_observed_at
    FROM asking_latest GROUP BY catalog_product_id
  ),
  asking_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM asking_latest
    WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
  ),
  asking_stats AS (
    SELECT
      catalog_product_id,
      MAX(sample_count) AS asking_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS asking_median_yen,
      MIN(price_yen) AS asking_min_yen,
      MAX(price_yen) AS asking_max_yen
    FROM asking_ranked
    GROUP BY catalog_product_id
  ),
  recent_asking_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM asking_latest
    WHERE sample_kind = 'asking'
      AND price_yen IS NOT NULL
      AND julianday(observed_at) >= julianday(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days'))
  ),
  recent_asking_stats AS (
    SELECT
      catalog_product_id,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS recent_asking_median_yen
    FROM recent_asking_ranked
    GROUP BY catalog_product_id
  ),
  listing_end_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM scoped
    WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
  ),
  listing_end_stats AS (
    SELECT
      catalog_product_id,
      MAX(sample_count) AS listing_end_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS listing_end_median_yen
    FROM listing_end_ranked
    GROUP BY catalog_product_id
  ),
  signal_stats AS (
    SELECT
      catalog_product_id,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'sold_out' THEN 1
          ELSE 0
        END
      ) AS sold_out_signal_count,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'deactivated' THEN 1
          ELSE 0
        END
      ) AS deactivated_signal_count
    FROM scoped
    GROUP BY catalog_product_id
  )
  SELECT
    catalog_ids.catalog_product_id,
    COALESCE(asking_observation_stats.observation_count, 0),
    asking_stats.asking_median_yen,
    asking_stats.asking_min_yen,
    asking_stats.asking_max_yen,
    recent_asking_stats.recent_asking_median_yen,
    COALESCE(listing_end_stats.listing_end_sample_count, 0),
    listing_end_stats.listing_end_median_yen,
    COALESCE(signal_stats.sold_out_signal_count, 0),
    COALESCE(signal_stats.deactivated_signal_count, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    COALESCE(asking_stats.asking_sample_count, 0),
    COALESCE(asking_context_stats.shop_count, 0),
    asking_context_stats.latest_observed_at,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM catalog_ids
  LEFT JOIN asking_stats USING (catalog_product_id)
  LEFT JOIN asking_observation_stats USING (catalog_product_id)
  LEFT JOIN asking_context_stats USING (catalog_product_id)
  LEFT JOIN recent_asking_stats USING (catalog_product_id)
  LEFT JOIN listing_end_stats USING (catalog_product_id)
  LEFT JOIN signal_stats USING (catalog_product_id)
    ON CONFLICT(catalog_product_id) DO UPDATE SET
    asking_sample_count = excluded.asking_sample_count,asking_median_yen = excluded.asking_median_yen,asking_min_yen = excluded.asking_min_yen,asking_max_yen = excluded.asking_max_yen,recent_asking_median_yen = excluded.recent_asking_median_yen,listing_end_sample_count = excluded.listing_end_sample_count,listing_end_median_yen = excluded.listing_end_median_yen,sold_out_signal_count = excluded.sold_out_signal_count,deactivated_signal_count = excluded.deactivated_signal_count,last_computed_at = excluded.last_computed_at,asking_listing_count = excluded.asking_listing_count,asking_shop_count = excluded.asking_shop_count,latest_asking_observed_at = excluded.latest_asking_observed_at,listing_basis_computed_at = excluded.listing_basis_computed_at;
DELETE FROM knowledge_catalog_price_indexes WHERE catalog_product_id = NEW.catalog_product_id
AND NOT EXISTS(SELECT 1 FROM knowledge_catalog_price_index_samples WHERE catalog_product_id = NEW.catalog_product_id);
INSERT INTO knowledge_catalog_price_indexes(catalog_product_id,asking_sample_count,asking_median_yen,asking_min_yen,asking_max_yen,recent_asking_median_yen,listing_end_sample_count,listing_end_median_yen,sold_out_signal_count,deactivated_signal_count,last_computed_at,asking_listing_count,asking_shop_count,latest_asking_observed_at,listing_basis_computed_at)
    
  WITH
  scoped AS MATERIALIZED (
    SELECT id, catalog_product_id, listing_product_id, shop_key, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE catalog_product_id = NEW.catalog_product_id
  ),
  catalog_ids AS (
    SELECT DISTINCT catalog_product_id FROM scoped
  ),
  asking_latest AS MATERIALIZED (
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY catalog_product_id, listing_product_id
        ORDER BY julianday(observed_at) DESC, id DESC) AS observation_rank
      FROM scoped WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
    ) WHERE observation_rank = 1
  ),
  asking_observation_stats AS (
    SELECT catalog_product_id, COUNT(*) AS observation_count
    FROM scoped WHERE sample_kind = 'asking' AND price_yen IS NOT NULL GROUP BY catalog_product_id
  ),
  asking_context_stats AS (
    SELECT catalog_product_id, COUNT(DISTINCT shop_key) AS shop_count, MAX(observed_at) AS latest_observed_at
    FROM asking_latest GROUP BY catalog_product_id
  ),
  asking_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM asking_latest
    WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
  ),
  asking_stats AS (
    SELECT
      catalog_product_id,
      MAX(sample_count) AS asking_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS asking_median_yen,
      MIN(price_yen) AS asking_min_yen,
      MAX(price_yen) AS asking_max_yen
    FROM asking_ranked
    GROUP BY catalog_product_id
  ),
  recent_asking_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM asking_latest
    WHERE sample_kind = 'asking'
      AND price_yen IS NOT NULL
      AND julianday(observed_at) >= julianday(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days'))
  ),
  recent_asking_stats AS (
    SELECT
      catalog_product_id,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS recent_asking_median_yen
    FROM recent_asking_ranked
    GROUP BY catalog_product_id
  ),
  listing_end_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM scoped
    WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
  ),
  listing_end_stats AS (
    SELECT
      catalog_product_id,
      MAX(sample_count) AS listing_end_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS listing_end_median_yen
    FROM listing_end_ranked
    GROUP BY catalog_product_id
  ),
  signal_stats AS (
    SELECT
      catalog_product_id,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'sold_out' THEN 1
          ELSE 0
        END
      ) AS sold_out_signal_count,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'deactivated' THEN 1
          ELSE 0
        END
      ) AS deactivated_signal_count
    FROM scoped
    GROUP BY catalog_product_id
  )
  SELECT
    catalog_ids.catalog_product_id,
    COALESCE(asking_observation_stats.observation_count, 0),
    asking_stats.asking_median_yen,
    asking_stats.asking_min_yen,
    asking_stats.asking_max_yen,
    recent_asking_stats.recent_asking_median_yen,
    COALESCE(listing_end_stats.listing_end_sample_count, 0),
    listing_end_stats.listing_end_median_yen,
    COALESCE(signal_stats.sold_out_signal_count, 0),
    COALESCE(signal_stats.deactivated_signal_count, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    COALESCE(asking_stats.asking_sample_count, 0),
    COALESCE(asking_context_stats.shop_count, 0),
    asking_context_stats.latest_observed_at,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM catalog_ids
  LEFT JOIN asking_stats USING (catalog_product_id)
  LEFT JOIN asking_observation_stats USING (catalog_product_id)
  LEFT JOIN asking_context_stats USING (catalog_product_id)
  LEFT JOIN recent_asking_stats USING (catalog_product_id)
  LEFT JOIN listing_end_stats USING (catalog_product_id)
  LEFT JOIN signal_stats USING (catalog_product_id)
    ON CONFLICT(catalog_product_id) DO UPDATE SET
    asking_sample_count = excluded.asking_sample_count,asking_median_yen = excluded.asking_median_yen,asking_min_yen = excluded.asking_min_yen,asking_max_yen = excluded.asking_max_yen,recent_asking_median_yen = excluded.recent_asking_median_yen,listing_end_sample_count = excluded.listing_end_sample_count,listing_end_median_yen = excluded.listing_end_median_yen,sold_out_signal_count = excluded.sold_out_signal_count,deactivated_signal_count = excluded.deactivated_signal_count,last_computed_at = excluded.last_computed_at,asking_listing_count = excluded.asking_listing_count,asking_shop_count = excluded.asking_shop_count,latest_asking_observed_at = excluded.latest_asking_observed_at,listing_basis_computed_at = excluded.listing_basis_computed_at;
END;

DROP TRIGGER IF EXISTS trg_price_index_sample_delete;
CREATE TRIGGER trg_price_index_sample_delete
AFTER DELETE
ON knowledge_catalog_price_index_samples
WHEN NOT EXISTS (SELECT 1 FROM knowledge_catalog_price_index_refresh_deferrals)
BEGIN
DELETE FROM knowledge_catalog_price_indexes WHERE catalog_product_id = OLD.catalog_product_id
AND NOT EXISTS(SELECT 1 FROM knowledge_catalog_price_index_samples WHERE catalog_product_id = OLD.catalog_product_id);
INSERT INTO knowledge_catalog_price_indexes(catalog_product_id,asking_sample_count,asking_median_yen,asking_min_yen,asking_max_yen,recent_asking_median_yen,listing_end_sample_count,listing_end_median_yen,sold_out_signal_count,deactivated_signal_count,last_computed_at,asking_listing_count,asking_shop_count,latest_asking_observed_at,listing_basis_computed_at)
    
  WITH
  scoped AS MATERIALIZED (
    SELECT id, catalog_product_id, listing_product_id, shop_key, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE catalog_product_id = OLD.catalog_product_id
  ),
  catalog_ids AS (
    SELECT DISTINCT catalog_product_id FROM scoped
  ),
  asking_latest AS MATERIALIZED (
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY catalog_product_id, listing_product_id
        ORDER BY julianday(observed_at) DESC, id DESC) AS observation_rank
      FROM scoped WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
    ) WHERE observation_rank = 1
  ),
  asking_observation_stats AS (
    SELECT catalog_product_id, COUNT(*) AS observation_count
    FROM scoped WHERE sample_kind = 'asking' AND price_yen IS NOT NULL GROUP BY catalog_product_id
  ),
  asking_context_stats AS (
    SELECT catalog_product_id, COUNT(DISTINCT shop_key) AS shop_count, MAX(observed_at) AS latest_observed_at
    FROM asking_latest GROUP BY catalog_product_id
  ),
  asking_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM asking_latest
    WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
  ),
  asking_stats AS (
    SELECT
      catalog_product_id,
      MAX(sample_count) AS asking_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS asking_median_yen,
      MIN(price_yen) AS asking_min_yen,
      MAX(price_yen) AS asking_max_yen
    FROM asking_ranked
    GROUP BY catalog_product_id
  ),
  recent_asking_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM asking_latest
    WHERE sample_kind = 'asking'
      AND price_yen IS NOT NULL
      AND julianday(observed_at) >= julianday(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days'))
  ),
  recent_asking_stats AS (
    SELECT
      catalog_product_id,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS recent_asking_median_yen
    FROM recent_asking_ranked
    GROUP BY catalog_product_id
  ),
  listing_end_ranked AS (
    SELECT
      catalog_product_id,
      price_yen,
      ROW_NUMBER() OVER (
        PARTITION BY catalog_product_id
        ORDER BY price_yen, id
      ) AS row_number,
      COUNT(*) OVER (PARTITION BY catalog_product_id) AS sample_count
    FROM scoped
    WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
  ),
  listing_end_stats AS (
    SELECT
      catalog_product_id,
      MAX(sample_count) AS listing_end_sample_count,
      CAST(
        ROUND(
          AVG(
            CASE
              WHEN row_number IN ((sample_count + 1) / 2, (sample_count + 2) / 2)
                THEN price_yen
            END
          )
        ) AS INTEGER
      ) AS listing_end_median_yen
    FROM listing_end_ranked
    GROUP BY catalog_product_id
  ),
  signal_stats AS (
    SELECT
      catalog_product_id,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'sold_out' THEN 1
          ELSE 0
        END
      ) AS sold_out_signal_count,
      SUM(
        CASE
          WHEN sample_kind = 'listing_end' AND signal_kind = 'deactivated' THEN 1
          ELSE 0
        END
      ) AS deactivated_signal_count
    FROM scoped
    GROUP BY catalog_product_id
  )
  SELECT
    catalog_ids.catalog_product_id,
    COALESCE(asking_observation_stats.observation_count, 0),
    asking_stats.asking_median_yen,
    asking_stats.asking_min_yen,
    asking_stats.asking_max_yen,
    recent_asking_stats.recent_asking_median_yen,
    COALESCE(listing_end_stats.listing_end_sample_count, 0),
    listing_end_stats.listing_end_median_yen,
    COALESCE(signal_stats.sold_out_signal_count, 0),
    COALESCE(signal_stats.deactivated_signal_count, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    COALESCE(asking_stats.asking_sample_count, 0),
    COALESCE(asking_context_stats.shop_count, 0),
    asking_context_stats.latest_observed_at,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM catalog_ids
  LEFT JOIN asking_stats USING (catalog_product_id)
  LEFT JOIN asking_observation_stats USING (catalog_product_id)
  LEFT JOIN asking_context_stats USING (catalog_product_id)
  LEFT JOIN recent_asking_stats USING (catalog_product_id)
  LEFT JOIN listing_end_stats USING (catalog_product_id)
  LEFT JOIN signal_stats USING (catalog_product_id)
    ON CONFLICT(catalog_product_id) DO UPDATE SET
    asking_sample_count = excluded.asking_sample_count,asking_median_yen = excluded.asking_median_yen,asking_min_yen = excluded.asking_min_yen,asking_max_yen = excluded.asking_max_yen,recent_asking_median_yen = excluded.recent_asking_median_yen,listing_end_sample_count = excluded.listing_end_sample_count,listing_end_median_yen = excluded.listing_end_median_yen,sold_out_signal_count = excluded.sold_out_signal_count,deactivated_signal_count = excluded.deactivated_signal_count,last_computed_at = excluded.last_computed_at,asking_listing_count = excluded.asking_listing_count,asking_shop_count = excluded.asking_shop_count,latest_asking_observed_at = excluded.latest_asking_observed_at,listing_basis_computed_at = excluded.listing_basis_computed_at;
END;
DROP TRIGGER IF EXISTS trg_price_index_sample_update_deferred;
CREATE TRIGGER trg_price_index_sample_update_deferred
AFTER UPDATE OF catalog_product_id,listing_product_id,shop_key,sample_kind,signal_kind,price_yen,observed_at
ON knowledge_catalog_price_index_samples
WHEN EXISTS (SELECT 1 FROM knowledge_catalog_price_index_refresh_deferrals)
BEGIN
  INSERT OR IGNORE INTO knowledge_catalog_price_index_dirty_products(catalog_product_id) VALUES(OLD.catalog_product_id);
  INSERT OR IGNORE INTO knowledge_catalog_price_index_dirty_products(catalog_product_id) VALUES(NEW.catalog_product_id);
END;

-- Independent-listing ranking starts NULL and converges without publishing old observation-weighted scores.
-- Avoid same-value score/index writes. Existing scores are already correct; no data backfill.
-- Runtime aggregates and price-index triggers can fire even when the computed score stays NULL.
DROP TRIGGER IF EXISTS product_search_entities_listing_deal_score_ai;
CREATE TRIGGER product_search_entities_listing_deal_score_ai
AFTER INSERT ON product_search_entities BEGIN
  UPDATE product_search_entities
  SET listing_deal_score = (
    SELECT CASE
      WHEN NEW.entity_kind = 'catalog'
        AND NEW.catalog_product_id IS NOT NULL
        AND i.asking_listing_count >= 3
        AND i.listing_basis_computed_at = i.last_computed_at
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
    AND listing_deal_score IS NOT (
    SELECT CASE
      WHEN NEW.entity_kind = 'catalog'
        AND NEW.catalog_product_id IS NOT NULL
        AND i.asking_listing_count >= 3
        AND i.listing_basis_computed_at = i.last_computed_at
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
-- the trigger to those columns prevents the UPDATE of listing_deal_score itself from recursing.
DROP TRIGGER IF EXISTS product_search_entities_listing_deal_score_au;
CREATE TRIGGER product_search_entities_listing_deal_score_au
AFTER UPDATE OF entity_kind, catalog_product_id, lowest_price_yen, lowest_in_stock_price_yen
ON product_search_entities BEGIN
  UPDATE product_search_entities
  SET listing_deal_score = (
    SELECT CASE
      WHEN NEW.entity_kind = 'catalog'
        AND NEW.catalog_product_id IS NOT NULL
        AND i.asking_listing_count >= 3
        AND i.listing_basis_computed_at = i.last_computed_at
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
    AND listing_deal_score IS NOT (
    SELECT CASE
      WHEN NEW.entity_kind = 'catalog'
        AND NEW.catalog_product_id IS NOT NULL
        AND i.asking_listing_count >= 3
        AND i.listing_basis_computed_at = i.last_computed_at
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
DROP TRIGGER IF EXISTS knowledge_catalog_price_indexes_listing_deal_score_ai;
CREATE TRIGGER knowledge_catalog_price_indexes_listing_deal_score_ai
AFTER INSERT ON knowledge_catalog_price_indexes BEGIN
  UPDATE product_search_entities
  SET listing_deal_score = CASE
    WHEN entity_kind = 'catalog'
      AND NEW.asking_listing_count >= 3
      AND NEW.listing_basis_computed_at = NEW.last_computed_at
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
    AND listing_deal_score IS NOT CASE
    WHEN entity_kind = 'catalog'
      AND NEW.asking_listing_count >= 3
      AND NEW.listing_basis_computed_at = NEW.last_computed_at
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

DROP TRIGGER IF EXISTS knowledge_catalog_price_indexes_listing_deal_score_au;
CREATE TRIGGER knowledge_catalog_price_indexes_listing_deal_score_au
AFTER UPDATE OF asking_listing_count, asking_median_yen, listing_basis_computed_at, last_computed_at ON knowledge_catalog_price_indexes BEGIN
  UPDATE product_search_entities
  SET listing_deal_score = CASE
    WHEN entity_kind = 'catalog'
      AND NEW.asking_listing_count >= 3
      AND NEW.listing_basis_computed_at = NEW.last_computed_at
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
    AND listing_deal_score IS NOT CASE
    WHEN entity_kind = 'catalog'
      AND NEW.asking_listing_count >= 3
      AND NEW.listing_basis_computed_at = NEW.last_computed_at
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

DROP TRIGGER IF EXISTS knowledge_catalog_price_indexes_listing_deal_score_ad;
CREATE TRIGGER knowledge_catalog_price_indexes_listing_deal_score_ad
AFTER DELETE ON knowledge_catalog_price_indexes BEGIN
  UPDATE product_search_entities
  SET listing_deal_score = NULL
  WHERE catalog_product_id = OLD.catalog_product_id
    AND listing_deal_score IS NOT NULL;
END;

UPDATE knowledge_catalog_price_index_recent_backfill_runs
SET after_catalog_product_id = 0, status = 'running', completed_at = NULL,
    page_token = NULL, next_batch_after = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE backfill_key = 'recent-price-index-v1';
