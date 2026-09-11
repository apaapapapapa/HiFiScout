#!/usr/bin/env bash
set -euo pipefail

# Optional full-history/ranked diagnostics, not part of the strict consistency gate.
source "$(dirname "${BASH_SOURCE[0]}")/lib/d1-health-query.sh"

identity="$(query "
  SELECT
    COUNT(*) AS resolution_count,
    SUM(CASE WHEN status = 'matched' THEN 1 ELSE 0 END) AS matched_count,
    SUM(CASE WHEN status = 'unresolved' THEN 1 ELSE 0 END) AS unresolved_count,
    SUM(CASE WHEN match_method = 'vetoed' THEN 1 ELSE 0 END) AS veto_count,
    SUM(CASE WHEN status = 'unresolved' AND candidate_catalog_product_id IS NOT NULL THEN 1 ELSE 0 END) AS candidate_count,
    MAX(evaluated_at) AS latest_evaluated_at
  FROM product_identity_resolutions;" "data_platform.identity")"

evidence="$(query "
  SELECT
    COUNT(*) AS evidence_count,
    COALESCE(SUM(content_bytes), 0) AS content_bytes,
    SUM(CASE WHEN COALESCE(r2_object_key, '') <> '' THEN 1 ELSE 0 END) AS object_key_count,
    MAX(captured_at) AS latest_captured_at
  FROM evidence_archive;" "data_platform.evidence")"

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
  LIMIT 25;" "data_platform.unresolved_manufacturers")"

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
  LIMIT 50;" "data_platform.unresolved_manufacturer_models")"

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
  LIMIT 25;" "data_platform.unresolved_models")"

remediation_events="$(query "
  SELECT
    field,
    reason,
    COUNT(*) AS change_count,
    MAX(processed_at) AS last_processed_at
  FROM data_quality_remediation_events
  GROUP BY field, reason
  ORDER BY change_count DESC, field, reason
  LIMIT 25;" "data_platform.remediation_events")"

remediation_queue="$(query "
  SELECT
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
    SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END) AS backlog,
    MIN(CASE WHEN status IN ('pending', 'processing') THEN created_at END) AS oldest_pending_at
  FROM data_quality_remediation_queue;" "data_platform.remediation_queue")"
remediation_queue_with_rates="$(jq 'map(. + {
  completed: ((.resolved // 0) + (.failed // 0)),
  failure_rate: (if (((.resolved // 0) + (.failed // 0)) > 0) then ((.failed // 0) / ((.resolved // 0) + (.failed // 0))) else null end)
})' <<< "$remediation_queue")"

report_diagnostic() {
  local title="$1" payload="$2"
  echo "$title:"
  jq . <<< "$payload"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      printf '\n### %s\n\n```json\n' "$title"
      jq . <<< "$payload"
      printf '```\n'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

report_diagnostic 'Product Identity including inactive listings' "$identity"
report_diagnostic 'Evidence metadata' "$evidence"
report_diagnostic 'Top unresolved manufacturer raw values' "$unresolved_manufacturers"
report_diagnostic 'Top unresolved manufacturer/model/shop groups' "$unresolved_manufacturer_models"
report_diagnostic 'Top model extraction failures' "$unresolved_models"
report_diagnostic 'Remediation changes recorded' "$remediation_events"
report_diagnostic 'Remediation queue operational state' "$remediation_queue_with_rates"
