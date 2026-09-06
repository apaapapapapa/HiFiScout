#!/usr/bin/env bash

D1_QUERY_MAX_ATTEMPTS=3
D1_QUERY_RETRY_SECONDS=5

# Log only D1 response metadata, never SQL/binds or result rows. stderr remains outside $(query).
# Malformed/failed responses are unknown costs, not zero-cost queries. Metadata from an invalid
# result shape still counts: a successful database execution may have to be retried by the caller.
log_d1_health_query_usage() {
  local output="$1" label="$2" attempt="$3" outcome="$4" entries
  if ! entries="$(jq -ce '
    if type == "array" then map(select(type == "object")) else [] end
    | if length == 0 then [{}] else . end
  ' <<< "$output" 2>/dev/null)"; then
    entries='[{}]'
  fi
  jq -c --arg query "$label" --arg outcome "$outcome" --argjson attempt "$attempt" '
    def metric: if type == "number" and . >= 0 then . else null end;
    to_entries[]
    | .key as $index
    | (.value.meta | if type == "object" then . else {} end) as $meta
    | ($meta.rows_read | metric) as $read
    | ($meta.rows_written | metric) as $written
    | {
        event: "operational_health_d1_query",
        query: $query,
        attempt: $attempt,
        statementIndex: $index,
        outcome: $outcome,
        rowsRead: $read,
        rowsWritten: $written,
        durationMs: ($meta.duration | metric),
        metadataPresent: ($read != null and $written != null)
      }
  ' <<< "$entries" >&2
}

# Existing health callers need the first statement's result rows on stdout. Each statement's
# metadata is emitted once per attempt without another D1 request or any persistent counters.
query() {
  local sql="$1" label="${2:?D1 health query requires a stable label}"
  local attempt output stderr_file

  stderr_file="$(mktemp)"
  for attempt in $(seq 1 "$D1_QUERY_MAX_ATTEMPTS"); do
    if output="$(npx wrangler d1 execute DB --remote --json --command "$sql" 2>"$stderr_file")"; then
      if jq -e 'type == "array" and length > 0 and all(.[]; type == "object" and .success != false and (.results | type == "array"))' >/dev/null 2>&1 <<< "$output"; then
        log_d1_health_query_usage "$output" "$label" "$attempt" success
        rm -f "$stderr_file"
        jq '.[0].results' <<< "$output"
        return 0
      fi
      log_d1_health_query_usage "$output" "$label" "$attempt" invalid_response
      echo "Remote D1 query ${label} returned an unexpected JSON shape (attempt ${attempt}/${D1_QUERY_MAX_ATTEMPTS})." >&2
    else
      log_d1_health_query_usage "$output" "$label" "$attempt" request_failed
      echo "Remote D1 query ${label} failed (attempt ${attempt}/${D1_QUERY_MAX_ATTEMPTS})." >&2
      cat "$stderr_file" >&2
    fi

    if [ "$attempt" -lt "$D1_QUERY_MAX_ATTEMPTS" ]; then
      sleep "$D1_QUERY_RETRY_SECONDS"
      : > "$stderr_file"
    fi
  done

  rm -f "$stderr_file"
  echo "Remote D1 query ${label} failed after ${D1_QUERY_MAX_ATTEMPTS} attempts." >&2
  return 1
}
