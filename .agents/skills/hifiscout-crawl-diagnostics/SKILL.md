---
name: hifiscout-crawl-diagnostics
description: "HiFiScoutのショップ収集停止、更新遅延、新着が出ない、商品文字列混入、ショップ追加を調査・修正する。Use for crawl/adapter/freshness problems; catalog-only official research belongs to catalog maintenance."
---

# HiFiScout crawl diagnostics

Read [crawl orchestration](../../../docs/crawl-orchestration.md) and, for parser/shop changes,
[adding shops](../../../docs/adding-shops.md). Use the current registry, `src/crawler/schedule.ts`,
`src/crawler/crawl-window.ts` and `wrangler.jsonc` for active shops, schedules and UTC/JST policy.
Do not infer a stopped crawl from an old issue, Queue count or elapsed overnight pause alone.

## Locate the break

Compare the affected shop with other shops using compact saved status/logs first. Separate:

| Boundary | Evidence to inspect |
| --- | --- |
| Eligibility/dispatch | Config/manual/quiet-hour pause, expected slot, immutable dispatch token |
| Collection | Owning DO step, next Alarm, progress, transport/parser error, backoff, last success |
| Persistence/finalization | Committed page receipt, coverage, cursor, pending stage work |
| Search projection | `last_projection_at`, durable obligations, entity membership/FTS |
| Display | API filters, stock scope, ordering, cache and rendered timestamp meaning |

An old **初回観測** is not the last crawl timestamp. Successful collection does not prove search
projection completion, and an API row not rendered may be a filter/order problem. D1 collection
counters can be checkpoints rather than the DO's latest live progress. Correlate by shop/run/token
and time; failed status reads remain unavailable, never idle/healthy.

## Repair the owning layer

- Preserve per-shop DO single-flight ownership, immutable dispatch-token fencing and
  PREPARE / Alarm / FETCH pacing. Recovery reuses the same generation/cursor; do not restore
  crawl Queue lanes, add a second execution lease or hold an invocation open with a sleep.
- Follow allowed hours, manual pauses, permits and retry/backoff rules. A missing control-plane
  read does not justify a new forced crawl. Use the existing admin recovery path when authorized.
- For parsing defects, use representative seller markup or retained structured evidence. Check
  card/detail boundaries, second-product contamination, shop-specific item numbers and price/stock
  extraction. Preserve actual revisions and meaningful model text when removing badges or notes.
  Keep seller extraction in the adapter and canonical resolution in shared catalog code.
- Check sibling adapters only where they share the defective helper or evidence pattern; avoid
  speculative global regex changes. New shops use the maintained scaffold and contract instead
  of editing scheduler/repository internals to special-case another shop.
- Preserve complete/partial/unknown coverage and deactivation guards. Missing inventory after
  partial collection or transient HTTP failure does not establish sold-out state. Reuse available
  detail evidence before adding seller requests, and retain redirect/response-size/robots guards.

## Verify recovery

Add deterministic fixtures for a reproduced defect and a negative case at its owning boundary;
CI must not fetch retailer sites. For orchestration changes verify interrupted/resumed steps,
duplicate starts, expired permits and delayed alarms as applicable. Inspect local D1 budgets for
work-amplification changes and actual DO CPU outcomes when claiming a production improvement.

Report collection recovery and public projection freshness separately, with observation times.
When a parser fix leaves old rows incorrect, use catalog maintenance to select bounded retained-data
replay rather than silently refetching or rewriting all shops. Do not enable paused health scans
to establish recovery; describe missing evidence and use the delivery skill for code changes.
