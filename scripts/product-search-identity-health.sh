#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/d1-health-query.sh"
D1_QUERY_RETRY_SECONDS=3

read_split_groups() {
  # The first observation has no identity key. Seek active/resolved rows instead of scanning
  # the exact-identity index's leading keys across every retired listing.
  local products='products p INDEXED BY idx_products_model_resolution'
  local label='product_search.split_groups' escaped_keys
  if [ -n "${split_group_keys:-}" ]; then
    # Values come from the first observation, not shell code. Escape JSON for one SQL literal.
    escaped_keys="${split_group_keys//\'/\'\'}"
    products="json_each('$escaped_keys') observed
      CROSS JOIN products p INDEXED BY idx_products_exact_identity
        ON p.canonical_manufacturer_id = json_extract(observed.value, '\$[0]')
       AND p.normalized_model = json_extract(observed.value, '\$[1]')"
    label='product_search.split_groups_recheck'
  fi
  query "
  SELECT
    p.canonical_manufacturer_id,
    p.normalized_model,
    COUNT(*) AS listing_count,
    COUNT(DISTINCT p.shop_key) AS shop_count,
    COUNT(DISTINCT m.entity_id) AS entity_count
  FROM $products
  LEFT JOIN product_search_entity_offers m ON m.listing_product_id = p.id
  LEFT JOIN product_identity_resolutions r
    ON r.listing_product_id = p.id
  LEFT JOIN knowledge_catalog_products kp
    ON kp.id = r.catalog_product_id AND r.status = 'matched' AND kp.verification_status = 'verified'
  WHERE p.is_active = 1
    AND p.model_resolution_status = 'resolved'
    AND COALESCE(p.canonical_manufacturer_id, '') <> ''
    AND COALESCE(p.normalized_model, '') <> ''
    AND COALESCE(r.match_method, '') <> 'vetoed'
    AND kp.id IS NULL
  GROUP BY p.canonical_manufacturer_id, p.normalized_model
  HAVING COUNT(*) > 1
    AND COUNT(DISTINCT m.entity_id) > 1
    AND COUNT(DISTINCT CASE
      WHEN p.primary_category_id NOT IN ('other', 'unclassified') THEN p.primary_category_id
      ELSE NULL
    END) <= 1
  ORDER BY listing_count DESC, shop_count DESC
  LIMIT 51;" "$label"
}

split_groups="$(read_split_groups)"
if [ "$(jq 'length' <<< "$split_groups")" -gt 50 ]; then
  echo 'Split identities exceed the retry scope; refusing a truncated convergence check.' >&2
  jq . <<< "$split_groups" >&2
  exit 1
fi
if [ "$(jq 'length' <<< "$split_groups")" -ne 0 ]; then
  split_group_keys="$(jq -cer 'map([.canonical_manufacturer_id, .normalized_model])
    | if all(.[]; all(.[]; type == "string" and length > 0)) then . else error("invalid identity keys") end' <<< "$split_groups")"
  # The deploy can finish just after a five-minute GENERAL_CRON boundary. The newly deployed repair
  # path has not had an opportunity to run in that case, so allow exactly one subsequent tick plus a
  # small execution grace period. Persistent drift is still reported by the second observation.
  # Recheck all peers of each captured identity, including identities whose original seed vanished.
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

if [ "$HEALTH_INCLUDE_DIAGNOSTICS" != '1' ]; then
  echo 'Representative groups and candidate diagnostics omitted; set HEALTH_INCLUDE_DIAGNOSTICS=1 for the extended report.'
  exit 0
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
