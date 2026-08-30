# Crawl orchestration migration — Phase 0 / Phase 1

Issue: #417

## Scope

Phase 0 and Phase 1 deliberately do **not** change the authoritative crawl execution path.

- Cloudflare Queue remains authoritative for crawl execution and continuation.
- A new per-shop `CrawlScheduler` Durable Object is deployed as an observation-only control-plane foundation.
- Only shops explicitly listed in `CRAWL_DO_SHADOW_SHOPS` are mirrored to the DO.
- The shadow DO reads the existing D1 resumable checkpoint; it does not mutate crawl lifecycle state and does not access sellers.
- Phase 2 is the first phase allowed to make one canary shop authoritative on the DO path.

This preserves the architecture invariant that routing is an explicit rollout decision. `fast` / `heavy` / `relay`, runtime cost, and current Queue quota are not DO-selection signals.

## Phase 0 baseline

Before any authoritative DO canary, retain a Queue baseline using the existing structured crawl logs plus the new delivery event.

### Signals

| Event | Meaning |
| --- | --- |
| `crawl_batch_dispatched` | Initial logical crawl jobs written by the scheduler |
| `crawl_dispatch_recovered` | Initial logical crawl job re-sent by recovery |
| `crawl_fetch_continuation_enqueued` | Continuation Queue write |
| `crawl_queue_baseline_delivery` | Every crawl Queue delivery/read observed by the Worker |
| `crawl_queue_job_continued` | Delivery completed and next continuation was persisted |
| `crawl_queue_job_deferred` | Delivery retried because the logical crawl step could not run yet |
| `crawl_queue_job_completed` / `crawl_queue_job_failed` | Terminal Queue delivery |
| `crawl_queue_job_dead_lettered` | Delivery reached a crawl DLQ |

For a normal successful Queue message, Cloudflare billing is approximately write + read + delete. Retries add reads, and DLQ transfer adds additional operations. Application logs do not attempt to replace Cloudflare account-level billing; they provide the per-shop/per-crawl attribution that the billing meter does not.

### Required baseline before Phase 2

Capture at least one representative 24-hour window and record:

- crawl Queue deliveries/day;
- initial dispatch writes/day;
- continuation writes/day;
- continuations per completed crawl (median / p95 / max);
- retries and DLQ deliveries/day;
- distribution by shop and lane;
- Queue allocation usage from Cloudflare account metrics for the same window.

Historical incident data from #391 already established roughly 1,850 Queue invocations over about 50 hours (~888/day), but it did not separate initial jobs from continuations. The Phase 0 event closes that attribution gap. Do not use the historical number as the Phase 2 go/no-go baseline if a fresh 24-hour window is available.

## Phase 1 Durable Object shadow contract

`CrawlScheduler` uses one Durable Object identity per shop.

```text
crawl Queue initial delivery
        |
        +---------------- authoritative ----------------> existing D1 resumable executor
        |
        +---- selected by CRAWL_DO_SHADOW_SHOPS -----> CrawlScheduler DO
                                                         |
                                                         +-- persist immutable observation command
                                                         +-- setAlarm(+10s)
                                                         +-- return
                                                               |
                                                             Alarm
                                                               |
                                                         read D1 checkpoint
                                                               |
                                                         emit observation
```

The DO stores only the compact observation command (`shopKey`, `requestedAt`, `jobId`, `runId`). HTML, products, frontier data, leases, phases, and crawl results remain in D1.

If the D1 session is not visible when the first Alarm fires, the observer performs at most three bounded observations with Alarm scheduling. It never polls with `sleep()` / `setTimeout()`.

### Safety properties

- Queue failure semantics and acknowledgements are unchanged in Phase 1.
- DO shadow failure cannot fail or retry the authoritative Queue crawl.
- The DO does not write `shop_sync_state`, `crawl_fetch_sessions`, `crawl_fetch_pages`, or any other crawl control table.
- The DO does not perform seller HTTP requests.
- No Queue/DO routing decision is based on Queue usage, lane classification, page count, item count, or observed runtime cost.
- DO storage is scheduler metadata only; D1 remains the durable system of record.
- Alarm execution is assumed at-least-once, so the observation command is keyed by stable dispatch/run identity and duplicate schedule requests are idempotent.

## Feature flag

`CRAWL_DO_SHADOW_SHOPS` is a comma-separated exact shop-key allowlist.

Examples:

```text
CRAWL_DO_SHADOW_SHOPS=""
CRAWL_DO_SHADOW_SHOPS="home-shokai"
CRAWL_DO_SHADOW_SHOPS="home-shokai,ippinkan"
```

There is deliberately no wildcard and no `heavy` / `relay` mode.

## Phase 2 gate

Do not make the DO authoritative for a shop until all of the following are available:

1. the fresh Phase 0 baseline above;
2. successful Phase 1 DO deployment and Alarm/checkpoint observations;
3. a bounded DO step executor that preserves the existing D1 idempotency/lease semantics;
4. Alarm-based pacing so seller rate limits are never implemented as DO `sleep()`;
5. rollback to the existing Queue path.

Relay-backed shops remain out of scope until the PREPARE/FETCH permit protocol in the later relay phase is implemented.
