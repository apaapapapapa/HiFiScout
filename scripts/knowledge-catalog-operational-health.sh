#!/usr/bin/env bash
set -euo pipefail

: "${PRODUCTION_BASE_URL:?PRODUCTION_BASE_URL is required}"

status_url="${PRODUCTION_BASE_URL%/}/api/knowledge-catalog/status"
payload=''
verifier_status=''
verifier_version=0
expected_version=0
queue_run_id=0
queue_completed=0
queue_dead_letter=0
latest_review_id=0
latest_review_status=''

for attempt in $(seq 1 16); do
  payload="$(curl -fsS --retry 3 --retry-delay 2 "$status_url")"
  verifier_status="$(jq -r '.verifier.status // empty' <<< "$payload")"
  verifier_version="$(jq -r '.verifier.version // 0' <<< "$payload")"
  expected_version="$(jq -r '.verifier.expectedVersion // 0' <<< "$payload")"
  queue_run_id="$(jq -r '.queue.latestRunId // 0' <<< "$payload")"
  queue_completed="$(jq -r '.queue.latestRun.completed // 0' <<< "$payload")"
  queue_dead_letter="$(jq -r '.queue.latestRun.deadLetter // 0' <<< "$payload")"
  latest_review_id="$(jq -r '.latestReview.id // 0' <<< "$payload")"
  latest_review_status="$(jq -r '.latestReview.status // empty' <<< "$payload")"
  queue_terminal=$((queue_completed + queue_dead_letter))

  if [ "$verifier_status" = 'failed' ] || [ "$latest_review_status" = 'failed' ]; then
    break
  fi

  # A newer scheduled review may start after the latest queue run completes. In that healthy
  # overlap, the review id is greater than the queue run id; equality would create a false alarm.
  if [ "$expected_version" -gt 0 ] \
    && [ "$verifier_version" -ge "$expected_version" ] \
    && [ "$verifier_status" = 'success' ] \
    && [ "$queue_run_id" -gt 0 ] \
    && [ "$latest_review_id" -ge "$queue_run_id" ] \
    && [ "$queue_terminal" -gt 0 ] \
    && { [ "$latest_review_status" = 'running' ] || [ "$latest_review_status" = 'success' ]; }; then
    break
  fi

  echo "Knowledge Catalog Queue bootstrap is not observable yet (attempt ${attempt}/16, run=${queue_run_id}, terminal=${queue_terminal}, review=${latest_review_status:-missing})."
  sleep 30
done

jq . <<< "$payload"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo '## Knowledge Catalog operational status'
    echo
    echo 'This is a post-deploy operational monitor. It is intentionally separate from browser E2E.'
    echo
    echo '```json'
    jq . <<< "$payload"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [ "$expected_version" -le 0 ]; then
  echo 'Knowledge Catalog verifier version is not exposed.' >&2
  exit 1
fi
if [ "$verifier_status" != 'success' ]; then
  echo "Knowledge Catalog verifier rollout status is ${verifier_status:-missing}." >&2
  exit 1
fi
if [ "$verifier_version" -lt "$expected_version" ]; then
  echo "Knowledge Catalog verifier v${expected_version} did not complete within the observation window; current v${verifier_version}." >&2
  exit 1
fi
if [ "$queue_run_id" -le 0 ]; then
  echo 'Knowledge Catalog Queue has not produced a verification run.' >&2
  exit 1
fi
if [ "$latest_review_id" -lt "$queue_run_id" ]; then
  echo "Knowledge Catalog latest review ${latest_review_id} lags Queue run ${queue_run_id}." >&2
  exit 1
fi
if [ $((queue_completed + queue_dead_letter)) -le 0 ]; then
  echo 'Knowledge Catalog Queue consumer has not completed a target job within the observation window.' >&2
  exit 1
fi
if [ "$latest_review_status" != 'running' ] && [ "$latest_review_status" != 'success' ]; then
  echo "Knowledge Catalog Queue review status is ${latest_review_status:-missing}." >&2
  exit 1
fi
