#!/usr/bin/env bash
set -euo pipefail

D1_QUERY_MAX_ATTEMPTS=3
D1_QUERY_RETRY_SECONDS=5
ACTIVE_CRAWL_CONVERGENCE_MAX_WAIT_SECONDS="${ACTIVE_CRAWL_CONVERGENCE_MAX_WAIT_SECONDS:-480}"
ACTIVE_CRAWL_CONVERGENCE_POLL_SECONDS="${ACTIVE_CRAWL_CONVERGENCE_POLL_SECONDS:-15}"

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

if ! [[ "$ACTIVE_CRAWL_CONVERGENCE_MAX_WAIT_SECONDS" =~ ^[0-9]+$ ]] || \
   ! [[ "$ACTIVE_CRAWL_CONVERGENCE_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid active crawl convergence timing configuration." >&2
  exit 2
fi

started_epoch="$(date +%s)"

while true; do
  blocking_sessions="$(read_blocking_sessions)"
  blocking_count="$(jq '[.[].active_session_count // 0] | add // 0' <<< "$blocking_sessions")"

  if [ "$blocking_count" -eq 0 ]; then
    echo "No active crawl is currently responsible for unresolved Product Identity coverage."
    exit 0
  fi

  now_epoch="$(date +%s)"
  elapsed_seconds="$((now_epoch - started_epoch))"
  if [ "$elapsed_seconds" -ge "$ACTIVE_CRAWL_CONVERGENCE_MAX_WAIT_SECONDS" ]; then
    echo "Active crawl convergence wait reached ${ACTIVE_CRAWL_CONVERGENCE_MAX_WAIT_SECONDS}s; continuing to the strict health checks." >&2
    jq . <<< "$blocking_sessions" >&2
    exit 0
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
