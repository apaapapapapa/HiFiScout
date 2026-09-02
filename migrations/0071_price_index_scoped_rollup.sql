-- Recompute the price index for one catalog product instead of for the whole ledger.
--
-- `knowledge_catalog_price_index_rollup` computes every catalog product's statistics in one pass.
-- Three of its CTEs rank samples with `ROW_NUMBER() OVER (PARTITION BY catalog_product_id ...)`,
-- and SQLite will not push an outer `WHERE catalog_product_id = ?` through a window function. The
-- sample triggers only ever want one product's row, but the query plan for
-- `SELECT ... FROM knowledge_catalog_price_index_rollup WHERE catalog_product_id = ?` therefore
-- reads:
--
--   MATERIALIZE asking_stats        -> SCAN knowledge_catalog_price_index_samples
--   MATERIALIZE recent_asking_stats -> SCAN knowledge_catalog_price_index_samples
--   MATERIALIZE listing_end_stats   -> SCAN knowledge_catalog_price_index_samples
--
-- Three full scans of the retention-safe ledger for every single sample written, and the update
-- trigger pays that twice because it refreshes both the old and the new aggregate. Measured against
-- a growing ledger the cost per written sample is linear in ledger size: 1.0 ms at 500 rows, 12.2 ms
-- at 8,000. On D1 that is billed as rows read, so a ledger of 20,000 rows spends roughly 60,000 row
-- reads per sample -- about eighty writes exhausts a free-tier day.
--
-- Filtering at the base instead makes the index `idx_knowledge_catalog_price_index_samples_catalog`
-- usable, so each CTE reads only the samples of the product being recomputed. The statistics
-- themselves are unchanged: the expressions below are the rollup's, with `PARTITION BY
-- catalog_product_id` dropped because the scope is already one product, and the `catalog_ids`
-- membership test kept as `WHERE EXISTS (SELECT 1 FROM scoped)` so a product with no samples still
-- produces no row.
--
-- The whole-ledger view is left in place. Nothing on the write path uses it any more; it remains
-- the readable definition of these statistics and the basis for a full rebuild.

DROP TRIGGER IF EXISTS trg_price_index_sample_insert;
DROP TRIGGER IF EXISTS trg_price_index_sample_delete;
DROP TRIGGER IF EXISTS trg_price_index_sample_update;

CREATE TRIGGER trg_price_index_sample_insert
AFTER INSERT ON knowledge_catalog_price_index_samples
BEGIN
  INSERT INTO knowledge_catalog_price_indexes(
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    last_computed_at
  )
  WITH scoped AS (
    SELECT id, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE catalog_product_id = NEW.catalog_product_id
  ),
  asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
  ),
  asking_stats AS (
    SELECT
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
  ),
  recent_asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking'
      AND price_yen IS NOT NULL
      AND julianday(observed_at) >= julianday('now', '-90 days')
  ),
  recent_asking_stats AS (
    SELECT
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
  ),
  listing_end_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
  ),
  listing_end_stats AS (
    SELECT
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
  ),
  signal_stats AS (
    SELECT
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
  )
  SELECT
    NEW.catalog_product_id,
    COALESCE(asking_stats.asking_sample_count, 0),
    asking_stats.asking_median_yen,
    asking_stats.asking_min_yen,
    asking_stats.asking_max_yen,
    recent_asking_stats.recent_asking_median_yen,
    COALESCE(listing_end_stats.listing_end_sample_count, 0),
    listing_end_stats.listing_end_median_yen,
    COALESCE(signal_stats.sold_out_signal_count, 0),
    COALESCE(signal_stats.deactivated_signal_count, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM asking_stats, recent_asking_stats, listing_end_stats, signal_stats
  WHERE EXISTS (SELECT 1 FROM scoped)
  ON CONFLICT(catalog_product_id) DO UPDATE SET
    asking_sample_count = excluded.asking_sample_count,
    asking_median_yen = excluded.asking_median_yen,
    asking_min_yen = excluded.asking_min_yen,
    asking_max_yen = excluded.asking_max_yen,
    recent_asking_median_yen = excluded.recent_asking_median_yen,
    listing_end_sample_count = excluded.listing_end_sample_count,
    listing_end_median_yen = excluded.listing_end_median_yen,
    sold_out_signal_count = excluded.sold_out_signal_count,
    deactivated_signal_count = excluded.deactivated_signal_count,
    last_computed_at = excluded.last_computed_at;
END;

CREATE TRIGGER trg_price_index_sample_delete
AFTER DELETE ON knowledge_catalog_price_index_samples
BEGIN
  DELETE FROM knowledge_catalog_price_indexes
  WHERE catalog_product_id = OLD.catalog_product_id
    AND NOT EXISTS (
      SELECT 1
      FROM knowledge_catalog_price_index_samples
      WHERE catalog_product_id = OLD.catalog_product_id
    );

  INSERT INTO knowledge_catalog_price_indexes(
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    last_computed_at
  )
  WITH scoped AS (
    SELECT id, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE catalog_product_id = OLD.catalog_product_id
  ),
  asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
  ),
  asking_stats AS (
    SELECT
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
  ),
  recent_asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking'
      AND price_yen IS NOT NULL
      AND julianday(observed_at) >= julianday('now', '-90 days')
  ),
  recent_asking_stats AS (
    SELECT
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
  ),
  listing_end_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
  ),
  listing_end_stats AS (
    SELECT
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
  ),
  signal_stats AS (
    SELECT
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
  )
  SELECT
    OLD.catalog_product_id,
    COALESCE(asking_stats.asking_sample_count, 0),
    asking_stats.asking_median_yen,
    asking_stats.asking_min_yen,
    asking_stats.asking_max_yen,
    recent_asking_stats.recent_asking_median_yen,
    COALESCE(listing_end_stats.listing_end_sample_count, 0),
    listing_end_stats.listing_end_median_yen,
    COALESCE(signal_stats.sold_out_signal_count, 0),
    COALESCE(signal_stats.deactivated_signal_count, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM asking_stats, recent_asking_stats, listing_end_stats, signal_stats
  WHERE EXISTS (SELECT 1 FROM scoped)
  ON CONFLICT(catalog_product_id) DO UPDATE SET
    asking_sample_count = excluded.asking_sample_count,
    asking_median_yen = excluded.asking_median_yen,
    asking_min_yen = excluded.asking_min_yen,
    asking_max_yen = excluded.asking_max_yen,
    recent_asking_median_yen = excluded.recent_asking_median_yen,
    listing_end_sample_count = excluded.listing_end_sample_count,
    listing_end_median_yen = excluded.listing_end_median_yen,
    sold_out_signal_count = excluded.sold_out_signal_count,
    deactivated_signal_count = excluded.deactivated_signal_count,
    last_computed_at = excluded.last_computed_at;
END;

-- A sample can move between catalog products, so both aggregates are refreshed.
CREATE TRIGGER trg_price_index_sample_update
AFTER UPDATE OF catalog_product_id, sample_kind, signal_kind, price_yen, observed_at
ON knowledge_catalog_price_index_samples
BEGIN
  DELETE FROM knowledge_catalog_price_indexes
  WHERE catalog_product_id = OLD.catalog_product_id
    AND NOT EXISTS (
      SELECT 1
      FROM knowledge_catalog_price_index_samples
      WHERE catalog_product_id = OLD.catalog_product_id
    );

  INSERT INTO knowledge_catalog_price_indexes(
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    last_computed_at
  )
  WITH scoped AS (
    SELECT id, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE catalog_product_id = OLD.catalog_product_id
  ),
  asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
  ),
  asking_stats AS (
    SELECT
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
  ),
  recent_asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking'
      AND price_yen IS NOT NULL
      AND julianday(observed_at) >= julianday('now', '-90 days')
  ),
  recent_asking_stats AS (
    SELECT
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
  ),
  listing_end_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
  ),
  listing_end_stats AS (
    SELECT
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
  ),
  signal_stats AS (
    SELECT
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
  )
  SELECT
    OLD.catalog_product_id,
    COALESCE(asking_stats.asking_sample_count, 0),
    asking_stats.asking_median_yen,
    asking_stats.asking_min_yen,
    asking_stats.asking_max_yen,
    recent_asking_stats.recent_asking_median_yen,
    COALESCE(listing_end_stats.listing_end_sample_count, 0),
    listing_end_stats.listing_end_median_yen,
    COALESCE(signal_stats.sold_out_signal_count, 0),
    COALESCE(signal_stats.deactivated_signal_count, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM asking_stats, recent_asking_stats, listing_end_stats, signal_stats
  WHERE EXISTS (SELECT 1 FROM scoped)
  ON CONFLICT(catalog_product_id) DO UPDATE SET
    asking_sample_count = excluded.asking_sample_count,
    asking_median_yen = excluded.asking_median_yen,
    asking_min_yen = excluded.asking_min_yen,
    asking_max_yen = excluded.asking_max_yen,
    recent_asking_median_yen = excluded.recent_asking_median_yen,
    listing_end_sample_count = excluded.listing_end_sample_count,
    listing_end_median_yen = excluded.listing_end_median_yen,
    sold_out_signal_count = excluded.sold_out_signal_count,
    deactivated_signal_count = excluded.deactivated_signal_count,
    last_computed_at = excluded.last_computed_at;

  INSERT INTO knowledge_catalog_price_indexes(
    catalog_product_id,
    asking_sample_count,
    asking_median_yen,
    asking_min_yen,
    asking_max_yen,
    recent_asking_median_yen,
    listing_end_sample_count,
    listing_end_median_yen,
    sold_out_signal_count,
    deactivated_signal_count,
    last_computed_at
  )
  WITH scoped AS (
    SELECT id, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE catalog_product_id = NEW.catalog_product_id
  ),
  asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking' AND price_yen IS NOT NULL
  ),
  asking_stats AS (
    SELECT
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
  ),
  recent_asking_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'asking'
      AND price_yen IS NOT NULL
      AND julianday(observed_at) >= julianday('now', '-90 days')
  ),
  recent_asking_stats AS (
    SELECT
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
  ),
  listing_end_ranked AS (
    SELECT
      price_yen,
      ROW_NUMBER() OVER (ORDER BY price_yen, id) AS row_number,
      COUNT(*) OVER () AS sample_count
    FROM scoped
    WHERE sample_kind = 'listing_end' AND price_yen IS NOT NULL
  ),
  listing_end_stats AS (
    SELECT
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
  ),
  signal_stats AS (
    SELECT
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
  )
  SELECT
    NEW.catalog_product_id,
    COALESCE(asking_stats.asking_sample_count, 0),
    asking_stats.asking_median_yen,
    asking_stats.asking_min_yen,
    asking_stats.asking_max_yen,
    recent_asking_stats.recent_asking_median_yen,
    COALESCE(listing_end_stats.listing_end_sample_count, 0),
    listing_end_stats.listing_end_median_yen,
    COALESCE(signal_stats.sold_out_signal_count, 0),
    COALESCE(signal_stats.deactivated_signal_count, 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM asking_stats, recent_asking_stats, listing_end_stats, signal_stats
  WHERE EXISTS (SELECT 1 FROM scoped)
  ON CONFLICT(catalog_product_id) DO UPDATE SET
    asking_sample_count = excluded.asking_sample_count,
    asking_median_yen = excluded.asking_median_yen,
    asking_min_yen = excluded.asking_min_yen,
    asking_max_yen = excluded.asking_max_yen,
    recent_asking_median_yen = excluded.recent_asking_median_yen,
    listing_end_sample_count = excluded.listing_end_sample_count,
    listing_end_median_yen = excluded.listing_end_median_yen,
    sold_out_signal_count = excluded.sold_out_signal_count,
    deactivated_signal_count = excluded.deactivated_signal_count,
    last_computed_at = excluded.last_computed_at;
END;
