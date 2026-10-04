---
name: hifiscout-crawl-diagnostics
description: "HiFiScoutのショップ収集停止・更新遅延・抽出不備・ショップ追加と、独立したYahooオークション収集境界の調査に使う。"
---

# HiFiScout crawl diagnostics

For scheduling/recovery use [crawl orchestration](../../../docs/crawl-orchestration.md); for parsing
or a new adapter use [adding shops](../../../docs/adding-shops.md). Current registry, schedule/window
code and `wrangler.jsonc` own active shops and UTC/JST policy. A new shop need not start with an outage audit.

## Auction boundary

For Yahoo auction work, start with the [auction runbook](../../../docs/yahoo-auctions.md) and current
`src/auctions/` policy/storage/DO code. Its collection, search and display gates are independent and
default to disabled in the committed configuration; inspect the authorized environment before claiming
runtime state. This is not a retail shop adapter or a per-shop CrawlScheduler generation. Preserve its
separate SQLite facts/search, bounded tasks/receipts, catalog-candidate expiry and resource budgets.
Auction bids never become retail prices, stock or price history. Public reads must not fetch the seller
or D1. Evidence of a stalled/disabled pilot does not authorize enabling it or bypassing its source gates.
The retail diagnosis below applies only after identifying a retail owner.

## Find the failed boundary

For freshness problems, correlate bounded saved status/logs by shop, run/token and time:

| Boundary | Evidence |
| --- | --- |
| Eligibility/dispatch | Config/manual/quiet-hour pause, expected slot, dispatch token |
| Collection | Owning DO step/Alarm, progress, error, backoff, last success |
| Persistence | Committed page receipt, coverage, cursor, pending stage work |
| Projection | `last_projection_at`, obligations, membership/FTS |
| Display | API stock/filter/order/cache and the rendered timestamp's meaning |

**初回観測** is not the last crawl. D1 counters can lag DO progress. Collection success does not prove
projection completion, and omitted UI rows may reflect filters/order. Failed status reads stay unknown;
an overnight pause, Queue count or old issue alone cannot establish an outage.

## Repair and establish recovery

Preserve the DO generation/pacing invariants in `AGENTS.md`, allowed hours, manual pauses and retry/
permit rules. Missing control-plane evidence does not justify a forced crawl. Use the existing admin
recovery path within authorization.

For parser defects, reproduce from seller markup or retained structured evidence. Check card/detail
and second-product boundaries, item numbers, price/stock and revision text. Extraction belongs in the
adapter; canonical resolution belongs in shared code. Inspect sibling adapters only if the defective
helper/evidence pattern is shared. New shops use the scaffold/common contract.

Preserve partial/unknown coverage and deactivation guards: transient failure cannot prove sold-out.
Reuse detail evidence before seller refetches and retain redirect, response-size and robots guards.
Add regression/counterexample fixtures for reproduced defects; CI must not fetch retailer sites.
Orchestration changes need relevant interrupted/resumed, duplicate-start, permit and Alarm cases;
work-amplification changes also need local D1 budgets. Production CPU claims require DO CPU evidence.

Report collection and projection recovery separately with observation times. If the fix leaves stored
rows wrong, select the bounded retained-data path through catalog maintenance. Paused health scans
remain paused; describe unavailable recovery evidence and finish code delivery under `AGENTS.md`.
