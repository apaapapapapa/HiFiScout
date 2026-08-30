#!/usr/bin/env bash
set -euo pipefail

query() {
  npx wrangler d1 execute DB --remote --json --command "$1" | jq '.[0].results // []'
}

verify_audiounion_inventory() {
  local result row in_stock
  result="$(npx wrangler d1 execute DB --remote --json --command "
    SELECT
      COUNT(*) AS active_count,
      SUM(CASE WHEN stock_status = 'in_stock' THEN 1 ELSE 0 END) AS in_stock_count,
      SUM(CASE WHEN stock_status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count,
      MAX(last_seen_at) AS latest_seen_at
    FROM products
    WHERE shop_key = 'audiounion' AND is_active = 1;")"
  row="$(jq -c '.[0].results[0] // {}' <<< "$result")"
  echo 'AudioUnion inventory state:'
  jq . <<< "$row"
  in_stock="$(jq -r '.in_stock_count // 0' <<< "$row")"
  if [ "$in_stock" -le 0 ]; then
    echo "AudioUnion has no active in-stock listings after the priced-listing fix." >&2
    exit 1
  fi
}

read_search_entities() {
  query "
    SELECT
      (SELECT COUNT(*) FROM product_search_entities) AS entity_count,
      (SELECT COUNT(*) FROM product_search_entities WHERE entity_kind = 'catalog') AS catalog_entity_count,
      (SELECT COUNT(*) FROM product_search_entities WHERE entity_kind = 'unresolved_listing') AS fallback_entity_count,
      (SELECT COUNT(*) FROM product_search_entities WHERE shop_count > 1) AS multi_shop_entity_count,
      (SELECT COUNT(*) FROM product_search_entity_offers) AS offer_count,
      (SELECT COUNT(*) FROM products p
        WHERE p.is_active = 1
          AND NOT EXISTS (SELECT 1 FROM product_search_entity_offers m WHERE m.listing_product_id = p.id)
      ) AS unmembered_active_listings,
      (SELECT COUNT(*) FROM product_search_entity_offers m
        JOIN products p ON p.id = m.listing_product_id
        WHERE p.is_active = 0
      ) AS inactive_offer_memberships,
      (SELECT COUNT(*) FROM product_search_entities e
        WHERE NOT EXISTS (SELECT 1 FROM product_search_entity_offers m WHERE m.entity_id = e.id)
      ) AS entities_without_offers,
      (SELECT COUNT(*) FROM product_search_entities e
        WHERE e.entity_kind = 'unresolved_listing'
          AND EXISTS (
            SELECT 1 FROM product_identity_resolutions r
            JOIN knowledge_catalog_products kp
              ON kp.id = r.catalog_product_id AND kp.verification_status = 'verified'
            WHERE r.listing_product_id = e.fallback_listing_id AND r.status = 'matched'
          )
      ) AS stale_fallback_entities,
      (SELECT COUNT(*) FROM product_search_entities e
        WHERE e.entity_kind = 'catalog'
          AND NOT EXISTS (
            SELECT 1 FROM knowledge_catalog_products kp
            WHERE kp.id = e.catalog_product_id AND kp.verification_status = 'verified'
          )
      ) AS ineligible_catalog_entities,
      (SELECT COUNT(*) FROM product_search_entities e
        WHERE e.offer_count <> (
          SELECT COUNT(*) FROM product_search_entity_offers m
          JOIN products p ON p.id = m.listing_product_id
          WHERE m.entity_id = e.id AND p.is_active = 1
        )
      ) AS offer_count_mismatches;"
}

search_drift_count() {
  jq '[.[0] | .unmembered_active_listings, .inactive_offer_memberships, .entities_without_offers, .stale_fallback_entities, .ineligible_catalog_entities, .offer_count_mismatches] | map(. // 0) | add' <<< "$1"
}

search_non_stale_drift_count() {
  jq '[.[0] | .unmembered_active_listings, .inactive_offer_memberships, .entities_without_offers, .ineligible_catalog_entities, .offer_count_mismatches] | map(. // 0) | add' <<< "$1"
}

verify_audiounion_inventory

identity="$(query "
  SELECT
    COUNT(*) AS resolution_count,
    SUM(CASE WHEN status = 'matched' THEN 1 ELSE 0 END) AS matched_count,
    SUM(CASE WHEN status = 'unresolved' THEN 1 ELSE 0 END) AS unresolved_count,
    SUM(CASE WHEN match_method = 'vetoed' THEN 1 ELSE 0 END) AS veto_count,
    SUM(CASE WHEN status = 'unresolved' AND candidate_catalog_product_id IS NOT NULL THEN 1 ELSE 0 END) AS candidate_count,
    MAX(evaluated_at) AS latest_evaluated_at
  FROM product_identity_resolutions;")"

evidence="$(query "
  SELECT
    COUNT(*) AS evidence_count,
    COALESCE(SUM(content_bytes), 0) AS content_bytes,
    SUM(CASE WHEN COALESCE(r2_object_key, '') <> '' THEN 1 ELSE 0 END) AS object_key_count,
    MAX(captured_at) AS latest_captured_at
  FROM evidence_archive;")"

shops="$(query "
  SELECT
    shop_key,
    COUNT(*) AS active_count,
    SUM(CASE WHEN stock_status = 'unknown' THEN 1 ELSE 0 END) AS inventory_unknown_count,
    MAX(last_seen_at) AS latest_seen_at
  FROM products
  WHERE is_active = 1
  GROUP BY shop_key
  ORDER BY shop_key;")"

baseline="$(query "
  SELECT
    p.shop_key,
    COUNT(*) AS total_items,
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
  ORDER BY p.shop_key;")"

unresolved_manufacturers="$(query "
  SELECT
    p.normalized_raw_manufacturer,
    MIN(p.raw_manufacturer) AS sample_raw_manufacturer,
    COUNT(*) AS active_listing_count,
    COUNT(DISTINCT p.shop_key) AS shop_count
  FROM products p
  WHERE p.is_active = 1 AND p.manufacturer_resolution_status <> 'resolved'
  GROUP BY p.normalized_raw_manufacturer
  ORDER BY active_listing_count DESC, shop_count DESC, p.normalized_raw_manufacturer
  LIMIT 25;")"

unresolved_manufacturer_models="$(query "
  SELECT
    p.canonical_manufacturer_id,
    p.normalized_model,
    p.shop_key,
    COUNT(*) AS active_listing_count
  FROM products p
  JOIN product_identity_resolutions r ON r.listing_product_id = p.id
  WHERE p.is_active = 1 AND r.status = 'unresolved'
  GROUP BY p.canonical_manufacturer_id, p.normalized_model, p.shop_key
  ORDER BY active_listing_count DESC, p.canonical_manufacturer_id,
           p.normalized_model, p.shop_key
  LIMIT 50;")"

unresolved_models="$(query "
  SELECT
    p.canonical_manufacturer_id,
    p.model_resolution_status,
    p.model_resolution_method,
    MIN(p.raw_model) AS sample_raw_model,
    COUNT(*) AS active_listing_count,
    COUNT(DISTINCT p.shop_key) AS shop_count
  FROM products p
  WHERE p.is_active = 1 AND p.model_resolution_status <> 'resolved'
  GROUP BY p.canonical_manufacturer_id, p.model_resolution_status,
           p.model_resolution_method
  ORDER BY active_listing_count DESC, shop_count DESC, p.canonical_manufacturer_id
  LIMIT 25;")"

remediation_events="$(query "
  SELECT
    field,
    reason,
    COUNT(*) AS change_count,
    MAX(processed_at) AS last_processed_at
  FROM data_quality_remediation_events
  GROUP BY field, reason
  ORDER BY change_count DESC, field, reason
  LIMIT 25;")"

remediation_queue="$(query "
  SELECT
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
    SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END) AS backlog,
    MIN(CASE WHEN status IN ('pending', 'processing') THEN created_at END) AS oldest_pending_at
  FROM data_quality_remediation_queue;")"
remediation_queue_with_rates="$(jq 'map(. + {
  completed: ((.resolved // 0) + (.failed // 0)),
  failure_rate: (if (((.resolved // 0) + (.failed // 0)) > 0) then ((.failed // 0) / ((.resolved // 0) + (.failed // 0))) else null end)
})' <<< "$remediation_queue")"

stale_resolver_versions="$(query "
  SELECT
    SUM(CASE WHEN manufacturer_resolver_version < 2 THEN 1 ELSE 0 END)
      AS stale_manufacturer_listings,
    SUM(CASE WHEN model_resolver_version < 2 THEN 1 ELSE 0 END)
      AS stale_model_listings
  FROM products
  WHERE is_active = 1;")"

# Listing writes and search projection refreshes are separate bounded D1 writes. Most intermediate
# states should disappear within seconds, so keep the short retry window. A stale fallback is the
# special case: the bounded projection repair is deliberately scheduled on GENERAL_CRON every five
# minutes, so post-deploy health must allow exactly one scheduler convergence window before calling
# that state unhealthy. Other kinds of drift do not get this extended grace period.
GENERAL_CRON_INTERVAL_SECONDS=300
PROJECTION_REPAIR_GRACE_SECONDS=45
search_entities="$(read_search_entities)"
search_drift="$(search_drift_count "$search_entities")"
if [ "$search_drift" -ne 0 ]; then
  non_stale_drift="$(search_non_stale_drift_count "$search_entities")"
  stale_fallback="$(jq '.[0].stale_fallback_entities // 0' <<< "$search_entities")"
  if [ "$non_stale_drift" -eq 0 ] && [ "$stale_fallback" -gt 0 ]; then
    now_epoch="$(date +%s)"
    next_general_tick="$(( ((now_epoch / GENERAL_CRON_INTERVAL_SECONDS) + 1) * GENERAL_CRON_INTERVAL_SECONDS ))"
    wait_seconds="$(( next_general_tick - now_epoch + PROJECTION_REPAIR_GRACE_SECONDS ))"
    echo "Only stale fallback entities remain; waiting ${wait_seconds}s for the next five-minute projection-repair tick." >&2
    jq . <<< "$search_entities" >&2
    sleep "$wait_seconds"
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
  search_entities="$(read_search_entities)"
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

quality_runs="$(query "
  SELECT q.*
  FROM data_quality_runs q
  WHERE q.id = (
    SELECT q2.id
    FROM data_quality_runs q2
    WHERE q2.shop_key = q.shop_key
    ORDER BY q2.evaluated_at DESC, q2.id DESC
    LIMIT 1
  )
  ORDER BY q.shop_key;")"

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
if ! npx wrangler d1 execute DB --remote --command \
  "INSERT INTO product_search_entities_fts(product_search_entities_fts) VALUES('integrity-check');" >/dev/null; then
  echo "Product search FTS integrity check failed; POST /api/admin/product-search/rebuild repairs the read model." >&2
  exit 1
fi

echo 'Product Identity production state:'
jq . <<< "$identity"
echo 'Evidence metadata production state:'
jq . <<< "$evidence"
echo 'Active listings by shop:'
jq . <<< "$shops"
echo 'Phase 2 snapshot baseline:'
jq . <<< "$baseline_with_rates"
echo 'Phase 4 product search read model:'
jq . <<< "$search_entities"
echo 'Latest persisted Phase 2 quality runs:'
jq . <<< "$quality_runs"
echo 'Top unresolved manufacturer raw values:'
jq . <<< "$unresolved_manufacturers"
echo 'Top unresolved manufacturer/model/shop groups:'
jq . <<< "$unresolved_manufacturer_models"
echo 'Top model extraction failures:'
jq . <<< "$unresolved_models"
echo 'Remediation changes recorded:'
jq . <<< "$remediation_events"
echo 'Remediation queue operational state:'
jq . <<< "$remediation_queue_with_rates"
echo 'Listings still behind the current resolver versions:'
jq . <<< "$stale_resolver_versions"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo '## Production Data Platform / Data Quality baseline'
    echo
    echo 'This report runs after deployment. A failure marks operational health degraded without rewriting the deployment result.'
    echo
    echo '#### Product Identity'
    echo '```json'
    jq . <<< "$identity"
    echo '```'
    echo
    echo '#### Evidence metadata'
    echo '```json'
    jq . <<< "$evidence"
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
    echo '### Top unresolved manufacturer raw values'
    echo '```json'
    jq . <<< "$unresolved_manufacturers"
    echo '```'
    echo
    echo '### Top unresolved manufacturer/model/shop groups'
    echo '```json'
    jq . <<< "$unresolved_manufacturer_models"
    echo '```'
    echo
    echo '### Top model extraction failures'
    echo '```json'
    jq . <<< "$unresolved_models"
    echo '```'
    echo
    echo '### Remediation changes recorded'
    echo '```json'
    jq . <<< "$remediation_events"
    echo '```'
    echo
    echo '### Remediation queue operational state'
    echo '```json'
    jq . <<< "$remediation_queue_with_rates"
    echo '```'
    echo
    echo '### Listings still behind the current resolver versions'
    echo '```json'
    jq . <<< "$stale_resolver_versions"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi
