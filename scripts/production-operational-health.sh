#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/d1-health-query.sh"

read_search_entities() {
  query "$(cat scripts/sql/search-entity-health.sql)" "data_platform.search_entities"
}

recheck_search_entities() {
  local sql
  sql="$(cat scripts/sql/search-entity-health-recheck.sql)"
  sql="${sql//__ENTITY_IDS__/$search_entity_ids}"
  sql="${sql//__LISTING_IDS__/$search_listing_ids}"
  query "$sql" "data_platform.search_entities_recheck"
}

search_drift_count() {
  jq '[.[0] | .unmembered_active_listings, .inactive_offer_memberships, .entities_without_offers, .stale_fallback_entities, .ineligible_catalog_entities, .offer_count_mismatches] | map(. // 0) | add' <<< "$1"
}

search_non_stale_drift_count() {
  jq '[.[0] | .unmembered_active_listings, .inactive_offer_memberships, .entities_without_offers, .ineligible_catalog_entities, .offer_count_mismatches] | map(. // 0) | add' <<< "$1"
}

baseline="$(query "
  SELECT
    p.shop_key,
    COUNT(*) AS total_items,
    SUM(CASE WHEN p.stock_status = 'in_stock' THEN 1 ELSE 0 END) AS in_stock_count,
    MAX(p.last_seen_at) AS latest_seen_at,
    SUM(CASE WHEN p.manufacturer_resolver_version < 2 THEN 1 ELSE 0 END) AS stale_manufacturer_listings,
    SUM(CASE WHEN p.model_resolver_version < 2 THEN 1 ELSE 0 END) AS stale_model_listings,
    SUM(CASE
      WHEN COALESCE(p.raw_manufacturer, '') = ''
       AND p.manufacturer_resolution_status <> 'resolved'
      THEN 1 ELSE 0 END) AS manufacturer_missing_count,
    SUM(CASE
      WHEN COALESCE(p.raw_manufacturer, '') <> ''
       AND p.manufacturer_resolution_status <> 'resolved'
      THEN 1 ELSE 0 END) AS manufacturer_unresolved_count,
    SUM(CASE WHEN p.classification_status <> 'classified' THEN 1 ELSE 0 END) AS category_unclassified_count,
    SUM(CASE WHEN p.classification_status = 'classified' AND p.primary_category_id = 'other' THEN 1 ELSE 0 END) AS other_category_count,
    SUM(CASE WHEN r.status = 'matched' THEN 1 ELSE 0 END) AS identity_matched_count,
    SUM(CASE WHEN r.status = 'unresolved' THEN 1 ELSE 0 END) AS identity_unresolved_count,
    SUM(CASE WHEN r.listing_product_id IS NULL THEN 1 ELSE 0 END) AS identity_resolution_missing_count,
    SUM(CASE WHEN r.match_method = 'vetoed' THEN 1 ELSE 0 END) AS identity_veto_count,
    SUM(CASE WHEN r.status = 'unresolved' AND r.candidate_catalog_product_id IS NOT NULL THEN 1 ELSE 0 END) AS identity_candidate_count,
    SUM(CASE WHEN p.stock_status <> 'unknown' THEN 1 ELSE 0 END) AS inventory_known_count,
    SUM(CASE WHEN p.stock_status = 'unknown' THEN 1 ELSE 0 END) AS inventory_unknown_count,
    SUM(CASE WHEN p.classification_status = 'classified' AND p.primary_category_id NOT IN ('other_accessory','cable','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_accessory','vacuum_tube','other') THEN 1 ELSE 0 END) AS model_expected_count,
    SUM(CASE WHEN p.classification_status = 'classified' AND p.primary_category_id NOT IN ('other_accessory','cable','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_accessory','vacuum_tube','other') AND p.model_resolution_status = 'resolved' THEN 1 ELSE 0 END) AS model_extracted_count,
    SUM(CASE WHEN p.classification_status = 'classified' AND p.primary_category_id NOT IN ('other_accessory','cable','cable_xlr','cable_rca','cable_phono','cable_usb','cable_lan','cable_digital','cable_power','cable_other','rack','power_accessory','vacuum_tube','other') AND p.model_resolution_status <> 'resolved' THEN 1 ELSE 0 END) AS model_missing_count
  FROM products p
  LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
  WHERE p.is_active = 1
  GROUP BY p.shop_key
  ORDER BY p.shop_key;" "data_platform.baseline")"

# These summaries share the required active-listing/identity scan above.
shops="$(jq 'map({shop_key, active_count: .total_items, inventory_unknown_count, latest_seen_at})' <<< "$baseline")"
identity="$(jq '[{
  resolution_count: ([.[] | .identity_matched_count + .identity_unresolved_count] | add // 0),
  matched_count: ([.[].identity_matched_count] | add // 0),
  unresolved_count: ([.[].identity_unresolved_count] | add // 0),
  veto_count: ([.[].identity_veto_count] | add // 0),
  candidate_count: ([.[].identity_candidate_count] | add // 0)
}]' <<< "$baseline")"
stale_resolver_versions="$(jq '[{
  stale_manufacturer_listings: ([.[].stale_manufacturer_listings] | add // 0),
  stale_model_listings: ([.[].stale_model_listings] | add // 0)
}]' <<< "$baseline")"
audiounion_inventory="$(jq '[.[] | select(.shop_key == "audiounion") | {
  active_count: .total_items, in_stock_count, unknown_count: .inventory_unknown_count, latest_seen_at
}]' <<< "$baseline")"
echo 'AudioUnion inventory state:'
jq . <<< "$audiounion_inventory"
if [ "$(jq '.[0].in_stock_count // 0' <<< "$audiounion_inventory")" -le 0 ]; then
  echo "AudioUnion has no active in-stock listings after the priced-listing fix." >&2
  exit 1
fi

# Listing writes and search projection refreshes are separate bounded D1 writes. Most intermediate
# states should disappear within seconds, so keep the short retry window. A stale fallback is the
# special case: the bounded projection repair is deliberately scheduled on GENERAL_CRON every five
# minutes, so post-deploy health must allow exactly one scheduler convergence window before calling
# that state unhealthy. Other kinds of drift do not get this extended grace period.
search_entities="$(read_search_entities)"
search_drift="$(search_drift_count "$search_entities")"
# Refuse a truncated retry scope. A large incident fails after the single full observation.
search_entity_ids="$(jq -cer '.[0].entity_ids | fromjson | if all(.[]; type == "number" and . > 0 and floor == .) then . else error("invalid entity IDs") end' <<< "$search_entities")"
search_listing_ids="$(jq -cer '.[0].listing_ids | fromjson | if all(.[]; type == "number" and . > 0 and floor == .) then . else error("invalid listing IDs") end' <<< "$search_entities")"
if [ "$(jq length <<< "$search_entity_ids")" -gt 1000 ] || [ "$(jq length <<< "$search_listing_ids")" -gt 1000 ]; then
  echo "Search drift exceeds the bounded retry scope; refusing to report partial convergence." >&2
  jq . <<< "$search_entities" >&2
  exit 1
fi
if [ "$search_drift" -ne 0 ]; then
  non_stale_drift="$(search_non_stale_drift_count "$search_entities")"
  stale_fallback="$(jq '.[0].stale_fallback_entities // 0' <<< "$search_entities")"
  if [ "$non_stale_drift" -eq 0 ] && [ "$stale_fallback" -gt 0 ]; then
    echo "Only stale fallback entities remain; allowing the shared projection-repair window." >&2
    jq . <<< "$search_entities" >&2
    bash scripts/wait-for-active-crawl-convergence.sh --projection-grace
  else
    echo "Product search read model is still inconsistent (observation 1/5); retrying in 10s." >&2
    jq . <<< "$search_entities" >&2
    sleep 10
  fi
fi

for attempt in 2 3 4 5; do
  if [ "$search_drift" -eq 0 ]; then
    break
  fi
  recheck="$(recheck_search_entities)"
  search_entities="$(jq -cn --argjson initial "$search_entities" --argjson current "$recheck" '[$initial[0] + $current[0]]')"
  search_drift="$(search_drift_count "$search_entities")"
  if [ "$search_drift" -eq 0 ]; then
    break
  fi
  if [ "$attempt" -lt 5 ]; then
    echo "Product search read model is still inconsistent (observation ${attempt}/5); retrying in 10s." >&2
    jq . <<< "$search_entities" >&2
    sleep 10
  fi
done

quality_runs="$(query "$(cat scripts/sql/latest-quality-runs.sql)" "data_platform.quality_runs")"

baseline_with_rates="$(jq 'map(. + {
  manufacturer_unknown_rate: (if .total_items > 0 then ((.manufacturer_missing_count + .manufacturer_unresolved_count) / .total_items) else null end),
  category_unclassified_rate: (if .total_items > 0 then (.category_unclassified_count / .total_items) else null end),
  identity_unresolved_rate: (if .total_items > 0 then ((.identity_unresolved_count + .identity_resolution_missing_count) / .total_items) else null end),
  identity_resolution_coverage_rate: (if .total_items > 0 then ((.identity_matched_count + .identity_unresolved_count) / .total_items) else null end),
  inventory_unknown_rate: (if ((.inventory_known_count + .inventory_unknown_count) > 0) then (.inventory_unknown_count / (.inventory_known_count + .inventory_unknown_count)) else null end),
  model_extraction_rate: (if .model_expected_count > 0 then (.model_extracted_count / .model_expected_count) else null end)
})' <<< "$baseline")"

identity_count="$(jq -r '.[0].resolution_count // 0' <<< "$identity")"
identity_missing_count="$(jq '[.[].identity_resolution_missing_count // 0] | add // 0' <<< "$baseline")"
shop_count="$(jq 'length' <<< "$shops")"

if [ "$identity_count" -le 0 ]; then
  echo "Product Identity has no production rows." >&2
  exit 1
fi
if [ "$shop_count" -le 0 ]; then
  echo "No active production shop data found." >&2
  exit 1
fi
if [ "$identity_missing_count" -ne 0 ]; then
  echo "Product Identity coverage gap detected: ${identity_missing_count} active listing(s) have no resolution row." >&2
  jq '[.[] | select((.identity_resolution_missing_count // 0) > 0) | {shop_key, total_items, identity_matched_count, identity_unresolved_count, identity_resolution_missing_count}]' <<< "$baseline" >&2
  exit 1
fi
if [ "$search_drift" -ne 0 ]; then
  echo "Product search read model drifted after its allowed convergence window; POST /api/admin/product-search/rebuild repairs it." >&2
  jq . <<< "$search_entities" >&2
  exit 1
fi
# Preserve the integrity check's original single attempt, but retain its D1 metadata too.
if ! (D1_QUERY_MAX_ATTEMPTS=1; query \
  "INSERT INTO product_search_entities_fts(product_search_entities_fts) VALUES('integrity-check');" \
  "data_platform.fts_integrity" >/dev/null); then
  echo "Product search FTS integrity check failed; POST /api/admin/product-search/rebuild repairs the read model." >&2
  exit 1
fi

echo 'Active Product Identity production state:'
jq . <<< "$identity"
echo 'Active listings by shop:'
jq . <<< "$shops"
echo 'Phase 2 snapshot baseline:'
jq . <<< "$baseline_with_rates"
echo 'Phase 4 product search read model:'
jq . <<< "$search_entities"
echo 'Latest persisted Phase 2 quality runs:'
jq . <<< "$quality_runs"
echo 'Listings still behind the current resolver versions:'
jq . <<< "$stale_resolver_versions"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo '## Production Data Platform / Data Quality baseline'
    echo
    echo 'This report runs after deployment. A failure marks operational health degraded without rewriting the deployment result.'
    echo
    echo '#### Active Product Identity'
    echo '```json'
    jq . <<< "$identity"
    echo '```'
    echo
    echo '#### Active listings by shop'
    echo '```json'
    jq . <<< "$shops"
    echo '```'
    echo
    echo '### Phase 2 snapshot baseline'
    echo '```json'
    jq . <<< "$baseline_with_rates"
    echo '```'
    echo
    echo '### Phase 4 product search read model'
    echo '```json'
    jq . <<< "$search_entities"
    echo '```'
    echo
    echo '### Latest persisted Phase 2 quality runs'
    echo '```json'
    jq . <<< "$quality_runs"
    echo '```'
    echo
    echo '### Listings still behind the current resolver versions'
    echo '```json'
    jq . <<< "$stale_resolver_versions"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [ "$HEALTH_INCLUDE_DIAGNOSTICS" = '1' ]; then
  bash scripts/production-operational-diagnostics.sh
else
  echo 'Historical and ranked diagnostics omitted; set HEALTH_INCLUDE_DIAGNOSTICS=1 for the extended report.'
fi
