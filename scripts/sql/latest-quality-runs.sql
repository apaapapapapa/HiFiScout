-- Seek each distinct shop through the existing index, including shops no longer in the registry.
-- DISTINCT/GROUP BY over history would still read every historical row.
WITH RECURSIVE shops(shop_key) AS (
  SELECT MIN(shop_key) FROM data_quality_runs
  UNION ALL
  SELECT (SELECT MIN(q.shop_key) FROM data_quality_runs q WHERE q.shop_key > shops.shop_key)
  FROM shops WHERE shop_key IS NOT NULL
)
SELECT q.* FROM shops
CROSS JOIN data_quality_runs q ON q.id = (
  SELECT latest.id FROM data_quality_runs latest WHERE latest.shop_key = shops.shop_key
  ORDER BY latest.evaluated_at DESC, latest.id DESC LIMIT 1
)
WHERE shops.shop_key IS NOT NULL
ORDER BY shops.shop_key;
