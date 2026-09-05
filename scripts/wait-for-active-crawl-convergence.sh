#!/usr/bin/env bash
set -euo pipefail

D1_QUERY_MAX_ATTEMPTS=3
D1_QUERY_RETRY_SECONDS=5
ACTIVE_CRAWL_CONVERGENCE_MAX_WAIT_SECONDS="${ACTIVE_CRAWL_CONVERGENCE_MAX_WAIT_SECONDS:-480}"
ACTIVE_CRAWL_CONVERGENCE_POLL_SECONDS="${ACTIVE_CRAWL_CONVERGENCE_POLL_SECONDS:-15}"
GENERAL_CRON_INTERVAL_SECONDS="${GENERAL_CRON_INTERVAL_SECONDS:-300}"

# All three operational checks share one projection-repair deadline. Initialize it only when
# drift is observed, after any active-crawl wait, and never grant a second cron window.
wait_for_projection_convergence() {
  local now_epoch deadline wait_seconds state_file
  now_epoch="$(date +%s)"
  state_file="${PROJECTION_CONVERGENCE_STATE_FILE:-}"
  if [[ -n "$state_file" && -s "$state_file" ]]; then
    deadline="$(cat "$state_file")"
    if ! [[ "$deadline" =~ ^[0-9]+$ ]]; then
      echo "Invalid shared projection convergence deadline." >&2
      return 2
    fi
  else
    if ! [[ "$GENERAL_CRON_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]] || \
       ! [[ "${PROJECTION_REPAIR_GRACE_SECONDS:-45}" =~ ^[0-9]+$ ]]; then
      echo "Invalid projection convergence timing configuration." >&2
      return 2
    fi
    deadline="$(( ((now_epoch / GENERAL_CRON_INTERVAL_SECONDS) + 1) * GENERAL_CRON_INTERVAL_SECONDS + ${PROJECTION_REPAIR_GRACE_SECONDS:-45} ))"
    if [[ -n "$state_file" ]]; then
      printf '%s\n' "$deadline" > "$state_file"
    fi
  fi
  wait_seconds="$((deadline - now_epoch))"
  if (( wait_seconds > 0 )); then
    echo "Waiting ${wait_seconds}s for the shared projection-repair deadline ${deadline}." >&2
    sleep "$wait_seconds"
  else
    echo "Shared projection-repair window already elapsed; checking the current state now." >&2
  fi
}

if [[ "${1:-}" == '--projection-grace' ]]; then
  wait_for_projection_convergence
  exit 0
fi
PROJECTION_REPAIR_GRACE_SECONDS="${PROJECTION_REPAIR_GRACE_SECONDS:-45}"

query() {
  local sql="$1"
  local attempt output stderr_file

  stderr_file="$(mktemp)"
  for attempt in $(seq 1 "$D1_QUERY_MAX_ATTEMPTS"); do
    if output="$(npx wrangler d1 execute DB --remote --json --command "$sql" 2>"$stderr_file")"; then
      if jq -e 'type == "array" and (.[0]? | type == "object") and ((.[0].results? // null) | type == "array")' >/dev/null 2>&1 <<< "$output"; then
        rm -f "$stderr_file"
        jq '.[0].results' <<< "$output"
        return 0
      fi
      echo "Remote D1 query returned an unexpected JSON shape (attempt ${attempt}/${D1_QUERY_MAX_ATTEMPTS})." >&2
      if ! jq -c '.' <<< "$output" >&2 2>/dev/null; then
        printf '%s\n' "$output" >&2
      fi
    else
      echo "Remote D1 query failed (attempt ${attempt}/${D1_QUERY_MAX_ATTEMPTS})." >&2
      cat "$stderr_file" >&2
    fi

    if [ "$attempt" -lt "$D1_QUERY_MAX_ATTEMPTS" ]; then
      sleep "$D1_QUERY_RETRY_SECONDS"
      : > "$stderr_file"
    fi
  done

  rm -f "$stderr_file"
  echo "Remote D1 query failed after ${D1_QUERY_MAX_ATTEMPTS} attempts." >&2
  return 1
}

read_blocking_sessions() {
  query "
    SELECT
      s.shop_key,
      COUNT(*) AS active_session_count,
      MIN(s.updated_at) AS oldest_session_update,
      MAX(s.updated_at) AS latest_session_update
    FROM crawl_fetch_sessions s
    WHERE s.status IN ('collecting', 'finalizing')
      AND EXISTS (
        SELECT 1
        FROM products p
        LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
        WHERE p.shop_key = s.shop_key
          AND p.is_active = 1
          AND r.listing_product_id IS NULL
      )
    GROUP BY s.shop_key
    ORDER BY s.shop_key;"
}

read_identity_gap_rows() {
  query "
    SELECT
      p.id,
      p.shop_key,
      p.source_id,
      p.title,
      p.raw_manufacturer,
      p.canonical_manufacturer_id,
      p.raw_model,
      p.normalized_model,
      p.primary_category_id,
      p.last_seen_at
    FROM products p
    LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
    WHERE p.is_active = 1
      AND r.listing_product_id IS NULL
    ORDER BY p.id
    LIMIT 25;"
}

if ! [[ "$ACTIVE_CRAWL_CONVERGENCE_MAX_WAIT_SECONDS" =~ ^[0-9]+$ ]] || \
   ! [[ "$ACTIVE_CRAWL_CONVERGENCE_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || \
   ! [[ "$GENERAL_CRON_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]] || \
   ! [[ "$PROJECTION_REPAIR_GRACE_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "Invalid crawl/projection convergence timing configuration." >&2
  exit 2
fi

started_epoch="$(date +%s)"
active_wait_exhausted=0

while true; do
  blocking_sessions="$(read_blocking_sessions)"
  blocking_count="$(jq '[.[].active_session_count // 0] | add // 0' <<< "$blocking_sessions")"

  if [ "$blocking_count" -eq 0 ]; then
    break
  fi

  now_epoch="$(date +%s)"
  elapsed_seconds="$((now_epoch - started_epoch))"
  if [ "$elapsed_seconds" -ge "$ACTIVE_CRAWL_CONVERGENCE_MAX_WAIT_SECONDS" ]; then
    echo "Active crawl convergence wait reached ${ACTIVE_CRAWL_CONVERGENCE_MAX_WAIT_SECONDS}s; continuing to the strict health checks." >&2
    jq . <<< "$blocking_sessions" >&2
    active_wait_exhausted=1
    break
  fi

  remaining_seconds="$((ACTIVE_CRAWL_CONVERGENCE_MAX_WAIT_SECONDS - elapsed_seconds))"
  sleep_seconds="$ACTIVE_CRAWL_CONVERGENCE_POLL_SECONDS"
  if [ "$sleep_seconds" -gt "$remaining_seconds" ]; then
    sleep_seconds="$remaining_seconds"
  fi

  echo "Product Identity coverage is temporarily incomplete while ${blocking_count} active crawl session(s) are still collecting/finalizing; retrying in ${sleep_seconds}s." >&2
  jq . <<< "$blocking_sessions" >&2
  sleep "$sleep_seconds"
done

if [ "$active_wait_exhausted" -eq 1 ]; then
  exit 0
fi

identity_gaps="$(read_identity_gap_rows)"
identity_gap_count="$(jq 'length' <<< "$identity_gaps")"
if [ "$identity_gap_count" -eq 0 ]; then
  echo "No active crawl or post-crawl Product Identity coverage gap requires convergence time."
  exit 0
fi

# Missing Identity rows are one of the exact gap types repaired by the bounded GENERAL_CRON
# projection sweep. A deployment can finish between a crawl commit and that five-minute sweep, so
# give the repair one scheduler tick before the strict health gate decides the state is persistent.
# This is intentionally one-shot: a poison listing remains visible to the strict check after the
# grace window instead of turning a permanent production defect into an indefinitely green deploy.
echo "${identity_gap_count} active listing(s) still lack Product Identity after crawl completion; allowing one shared GENERAL_CRON projection-repair window." >&2
jq . <<< "$identity_gaps" >&2
wait_for_projection_convergence

remaining_identity_gaps="$(read_identity_gap_rows)"
remaining_identity_gap_count="$(jq 'length' <<< "$remaining_identity_gaps")"
if [ "$remaining_identity_gap_count" -gt 0 ]; then
  echo "Product Identity gaps remain after the GENERAL_CRON convergence window; strict health checks will fail if they are still authoritative." >&2
  jq . <<< "$remaining_identity_gaps" >&2
else
  echo "Product Identity coverage converged during the GENERAL_CRON repair window."
fi
