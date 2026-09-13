---
name: hifiscout-crawl-diagnostics
description: "HiFiScoutのショップ収集停止・更新遅延・新着欠落・抽出不備の調査修正とショップ追加に使う。"
---

# HiFiScout crawl diagnostics

For scheduling/recovery use [crawl orchestration](../../../docs/crawl-orchestration.md); for parsing
or a new adapter use [adding shops](../../../docs/adding-shops.md). Current registry, schedule/window
code and `wrangler.jsonc` own active shops and UTC/JST policy. A new shop need not start with an outage audit.

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
