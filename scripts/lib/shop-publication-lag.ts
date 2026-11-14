import type { QueryableDatabase } from "../../src/db/types.js";

/**
 * Read-only, bounded cohort: listings first discovered in [start, end).
 * Unlike last_seen_at, first_seen_at is immutable. A source date alone is not a timestamp:
 * Hifido midnight and Dynamic Audio date-only fallbacks never enter minute-level statistics.
 * SQL keeps per-product rows inside D1 and returns one small aggregate per shop.
 */
const SHOP_PUBLICATION_LAG_SQL = `
WITH observations AS (
  SELECT
    shop_key,
    first_seen_at,
    source_published_at,
    CASE
      WHEN source_published_at IS NULL THEN 'missing'
      WHEN shop_key = 'dynamic-audio'
        AND COALESCE(json_extract(metadata_json, '$.sourcePublishedPrecision'), 'day') = 'day'
        THEN 'day'
      WHEN shop_key = 'hifido'
        AND strftime('%H:%M:%S', source_published_at, '+9 hours') = '00:00:00'
        THEN 'day'
      ELSE 'second'
    END AS precision,
    (julianday(first_seen_at) - julianday(source_published_at)) * 1440 AS lag_minutes,
    CAST(
      julianday(date(first_seen_at, '+9 hours'))
      - julianday(date(source_published_at, '+9 hours')) AS INTEGER
    ) AS lag_days
  FROM products
  WHERE first_seen_at >= ? AND first_seen_at < ?
),
precise_ranked AS (
  SELECT
    shop_key,
    lag_minutes,
    ROW_NUMBER() OVER (PARTITION BY shop_key ORDER BY lag_minutes) AS rn,
    COUNT(*) OVER (PARTITION BY shop_key) AS n
  FROM observations
  WHERE precision = 'second' AND lag_minutes >= 0
),
precise_percentiles AS (
  SELECT
    shop_key,
    MAX(CASE WHEN rn = (n + 1) / 2 THEN ROUND(lag_minutes) END) AS p50_minutes,
    MAX(CASE WHEN rn = (n * 9 + 9) / 10 THEN ROUND(lag_minutes) END) AS p90_minutes
  FROM precise_ranked
  GROUP BY shop_key
),
shop_counts AS (
  SELECT
    shop_key,
    COUNT(*) AS first_seen_count,
    SUM(CASE WHEN source_published_at IS NOT NULL THEN 1 ELSE 0 END) AS sourced_count,
    SUM(CASE WHEN precision = 'second' AND lag_minutes >= 0 THEN 1 ELSE 0 END) AS precise_count,
    SUM(CASE WHEN precision = 'day' AND lag_days >= 0 THEN 1 ELSE 0 END) AS day_count,
    SUM(CASE WHEN source_published_at IS NOT NULL AND lag_minutes < 0 THEN 1 ELSE 0 END) AS future_count,
    SUM(CASE WHEN source_published_at IS NOT NULL AND lag_minutes IS NULL THEN 1 ELSE 0 END) AS invalid_count,
    SUM(CASE WHEN precision = 'second' AND lag_minutes BETWEEN 0 AND 60 THEN 1 ELSE 0 END) AS within_hour_count,
    SUM(CASE WHEN precision = 'day' AND lag_days = 0 THEN 1 ELSE 0 END) AS same_day_count
  FROM observations
  GROUP BY shop_key
)
SELECT
  s.shop_key,
  COALESCE(c.first_seen_count, 0) AS first_seen_count,
  COALESCE(c.sourced_count, 0) AS sourced_count,
  COALESCE(c.precise_count, 0) AS precise_count,
  COALESCE(c.day_count, 0) AS day_count,
  COALESCE(c.future_count, 0) AS future_count,
  COALESCE(c.invalid_count, 0) AS invalid_count,
  COALESCE(c.within_hour_count, 0) AS within_hour_count,
  COALESCE(c.same_day_count, 0) AS same_day_count,
  p.p50_minutes,
  p.p90_minutes
FROM shop_sync_state s
LEFT JOIN shop_counts c ON c.shop_key = s.shop_key
LEFT JOIN precise_percentiles p ON p.shop_key = s.shop_key
ORDER BY s.shop_key
`;

export interface ShopPublicationLagRow {
  shop_key: string;
  first_seen_count: number;
  sourced_count: number;
  precise_count: number;
  day_count: number;
  future_count: number;
  invalid_count: number;
  within_hour_count: number;
  same_day_count: number;
  p50_minutes: number | null;
  p90_minutes: number | null;
}

export interface ShopPublicationLagReport {
  readonly schemaVersion: 1;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly shops: readonly ShopPublicationLagRow[];
}

/** No writes, backfill jobs or crawl requests; a single D1 aggregate over the bounded cohort. */
export async function reportShopPublicationLag(
  db: QueryableDatabase,
  start: Date,
  end: Date,
): Promise<ShopPublicationLagReport> {
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start >= end ||
    end.getTime() - start.getTime() > 90 * 86_400_000
  ) {
    throw new Error("Publication lag report requires a valid window of at most 90 days");
  }
  const result = await db
    .prepare(SHOP_PUBLICATION_LAG_SQL)
    .bind(start.toISOString(), end.toISOString())
    .all<ShopPublicationLagRow>();
  return {
    schemaVersion: 1,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    shops: result.results ?? [],
  };
}
