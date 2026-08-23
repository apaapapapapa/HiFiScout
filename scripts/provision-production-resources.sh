#!/usr/bin/env bash
set -euo pipefail

bucket="hifiscout-evidence"
if npx wrangler r2 bucket info "$bucket" >/dev/null 2>&1; then
  echo "R2 bucket already exists: $bucket"
else
  npx wrangler r2 bucket create "$bucket"
fi

while IFS='|' read -r name prefix days; do
  npx wrangler r2 bucket lifecycle remove "$bucket" --id "$name" >/dev/null 2>&1 || true
  npx wrangler r2 bucket lifecycle add "$bucket" "$name" "$prefix" --expire-days "$days"
done <<'RULES'
hifiscout-evidence-short|evidence/short/|30
hifiscout-evidence-medium|evidence/medium/|90
hifiscout-evidence-long|evidence/long/|365
hifiscout-product-audit-exports|product-audit-exports/|10
hifiscout-knowledge-catalog-exports|knowledge-catalog-exports/|10
RULES

ensure_queue() {
  local queue="$1"
  if npx wrangler queues info "$queue" >/dev/null 2>&1; then
    echo "Queue already exists: $queue"
  else
    npx wrangler queues create "$queue"
  fi
}

for queue in \
  hifiscout-crawl hifiscout-crawl-dlq \
  hifiscout-crawl-fast hifiscout-crawl-fast-dlq \
  hifiscout-crawl-heavy hifiscout-crawl-heavy-dlq \
  hifiscout-crawl-relay hifiscout-crawl-relay-dlq \
  hifiscout-knowledge-verification hifiscout-knowledge-verification-dlq \
  hifiscout-product-audit-export hifiscout-product-audit-export-dlq; do
  ensure_queue "$queue"
done
