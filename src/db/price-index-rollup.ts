/** Asking medians give each listing one vote, using its latest retained observation.
 * Observation count, independent listings, shops and recency remain separate facts. */
export function priceIndexRollupSql(
  scope: string,
  cutoff = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')",
  at = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
): string {
  return `
  WITH
  scoped AS MATERIALIZED (
    SELECT id, catalog_product_id, listing_product_id, shop_key, sample_kind, signal_kind, price_yen, observed_at
    FROM knowledge_catalog_price_index_samples
    WHERE ${scope}
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
      AND julianday(observed_at) >= julianday(${cutoff})
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
    ${at},
    COALESCE(asking_stats.asking_sample_count, 0),
    COALESCE(asking_context_stats.shop_count, 0),
    asking_context_stats.latest_observed_at,
    ${at}
  FROM catalog_ids
  LEFT JOIN asking_stats USING (catalog_product_id)
  LEFT JOIN asking_observation_stats USING (catalog_product_id)
  LEFT JOIN asking_context_stats USING (catalog_product_id)
  LEFT JOIN recent_asking_stats USING (catalog_product_id)
  LEFT JOIN listing_end_stats USING (catalog_product_id)
  LEFT JOIN signal_stats USING (catalog_product_id)`;
}

export const PRICE_INDEX_ROLLUP_COLUMNS = [
  "catalog_product_id",
  "asking_sample_count",
  "asking_median_yen",
  "asking_min_yen",
  "asking_max_yen",
  "recent_asking_median_yen",
  "listing_end_sample_count",
  "listing_end_median_yen",
  "sold_out_signal_count",
  "deactivated_signal_count",
  "last_computed_at",
  "asking_listing_count",
  "asking_shop_count",
  "latest_asking_observed_at",
  "listing_basis_computed_at",
] as const;

export function priceIndexRollupUpsertSql(scope: string, cutoff?: string, at?: string): string {
  return `INSERT INTO knowledge_catalog_price_indexes(${PRICE_INDEX_ROLLUP_COLUMNS.join(",")})
    ${priceIndexRollupSql(scope, cutoff, at)}
    ON CONFLICT(catalog_product_id) DO UPDATE SET
    ${PRICE_INDEX_ROLLUP_COLUMNS.filter((column) => column !== "catalog_product_id")
      .map((column) => `${column} = excluded.${column}`)
      .join(",")}`;
}
