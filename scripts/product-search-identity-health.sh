#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/d1-health-query.sh"
D1_QUERY_RETRY_SECONDS=3

read_split_groups() {
  query "
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
      WHEN p.primary_category_id NOT IN ('other', 'unclassified') THEN p.primary_category_id
      ELSE NULL
    END) <= 1
  ORDER BY listing_count DESC, shop_count DESC
  LIMIT 50;" "product_search.split_groups"
}

split_groups="$(read_split_groups)"
if [ "$(jq 'length' <<< "$split_groups")" -ne 0 ]; then
  # The deploy can finish just after a five-minute GENERAL_CRON boundary. The newly deployed repair
  # path has not had an opportunity to run in that case, so allow exactly one subsequent tick plus a
  # small execution grace period. Persistent drift is still reported by the second observation.
  echo "Safe exact identities are split; allowing the shared post-deploy repair window." >&2
  jq . <<< "$split_groups" >&2
  bash scripts/wait-for-active-crawl-convergence.sh --projection-grace
  split_groups="$(read_split_groups)"
fi

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
  LIMIT 30;" "product_search.grouped_products")"
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
  LIMIT 30;" "product_search.candidate_presentations")"
echo 'Repeated unresolved model presentations (diagnostic only):'
jq . <<< "$candidates"
