#!/usr/bin/env bash
set -euo pipefail

query() {
  local sql="$1"
  local attempt output
  for attempt in 1 2 3; do
    if output="$(npx wrangler d1 execute DB --remote --json --command "$sql")"; then
      jq '.[0].results // []' <<< "$output"
      return 0
    fi
    echo "Product Search operational query failed (attempt ${attempt}/3)." >&2
    if [ "$attempt" -lt 3 ]; then
      sleep 3
    fi
  done
  return 1
}

split_groups="$(query "
  SELECT
    p.canonical_manufacturer_id,
    p.normalized_model,
    COUNT(*) AS listing_count,
    COUNT(DISTINCT p.shop_key) AS shop_count,
    COUNT(DISTINCT m.entity_id) AS entity_count
  FROM products p
  JOIN product_search_entity_offers m ON m.listing_product_id = p.id
  LEFT JOIN product_identity_resolutions r
    ON r.listing_product_id = p.id AND r.status = 'matched'
  LEFT JOIN knowledge_catalog_products kp
    ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
  WHERE p.is_active = 1
    AND p.model_resolution_status = 'resolved'
    AND COALESCE(p.canonical_manufacturer_id, '') <> ''
    AND COALESCE(p.normalized_model, '') <> ''
    AND kp.id IS NULL
  GROUP BY p.canonical_manufacturer_id, p.normalized_model
  HAVING COUNT(*) > 1
    AND COUNT(DISTINCT m.entity_id) > 1
    AND COUNT(DISTINCT CASE
      WHEN p.primary_category_id <> 'other' THEN p.primary_category_id
      ELSE NULL
    END) <= 1
  ORDER BY listing_count DESC, shop_count DESC
  LIMIT 50;")"

echo 'Safe exact identities still split across cards:'
jq . <<< "$split_groups"
if [ "$(jq 'length' <<< "$split_groups")" -ne 0 ]; then
  echo 'Safe exact product identities are split across Product Search entities.' >&2
  exit 1
fi

grouped="$(query "
  SELECT
    e.manufacturer,
    e.model,
    e.offer_count,
    e.shop_count,
    e.lowest_price_yen,
    e.highest_price_yen
  FROM product_search_entities e
  WHERE e.offer_count > 1
  ORDER BY e.shop_count DESC, e.offer_count DESC, e.latest_activity_at DESC
  LIMIT 30;")"
echo 'Representative grouped products:'
jq . <<< "$grouped"

candidates="$(query "
  SELECT
    p.canonical_manufacturer_id,
    MIN(p.model) AS sample_model,
    COUNT(*) AS listing_count,
    COUNT(DISTINCT p.shop_key) AS shop_count,
    GROUP_CONCAT(DISTINCT p.shop_key) AS shops
  FROM products p
  WHERE p.is_active = 1
    AND p.model_resolution_status <> 'resolved'
    AND COALESCE(p.canonical_manufacturer_id, '') <> ''
    AND COALESCE(TRIM(p.model), '') <> ''
  GROUP BY p.canonical_manufacturer_id, UPPER(TRIM(p.model))
  HAVING COUNT(*) > 1
  ORDER BY shop_count DESC, listing_count DESC
  LIMIT 30;")"
echo 'Repeated unresolved model presentations (diagnostic only):'
jq . <<< "$candidates"
