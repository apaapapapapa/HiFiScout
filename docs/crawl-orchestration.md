# Crawl orchestration

The per-shop `CrawlScheduler` Durable Object is the authoritative crawl control plane. Cloudflare Queues serve independent post-commit work such as Knowledge Catalog verification and CSV exports; Queue capacity, quota, backlog, or lane selection must not control whether a crawl runs. Current entry points are `src/worker.ts`, `src/scheduled.ts`, `src/crawler/dispatch.ts`, and `src/crawler/crawl-scheduler-do.ts`.

## Runtime model

1. A crawl Cron selects an eligible shop. General Cron owns watchdog/maintenance work and does not start new shop crawls; rotation and dedicated shop crons are defined in `src/scheduled.ts` and the plugin registry.
2. D1 atomically reserves one immutable dispatch generation in `shop_sync_state`:
   - `dispatch_requested_at`
   - `dispatch_token`
   - `dispatch_last_sent_at`
3. The Worker POSTs the immutable command to the shop's `CrawlScheduler` Durable Object.
4. The Durable Object stores the active execution and schedules an Alarm.
5. Each Alarm performs at most one bounded transition or one prepared seller request:
   - initialize / fetch-and-parse / finalize (legacy staged HTML resumes through parse),
   - staged category-detail fetch,
   - Relay inventory recheck.
6. Any seller pacing delay is represented by an Alarm timestamp. The control plane does not `sleep()` or hold an invocation open while waiting.
7. Direct and Relay HTTP both use PREPARE -> Alarm -> FETCH semantics. Relay permits can expire; an expired permit is discarded and prepared again rather than bypassing pacing.
8. D1 crawl-session rows preserve resumable collection state. The dispatch token fences delayed or replayed `/start-crawl` deliveries so an older generation cannot execute a newer reservation.
9. A terminal crawl releases only its exact D1 dispatch token. A continuation or retry keeps the reservation.

The Durable Object is the single-flight authority. D1 does not maintain a second execution lease. The D1 dispatch row is a generation fence and scheduler recovery marker, not a Queue-consumer lease.

`src/crawler/crawl-lifecycle.ts` exposes `idle`, `dispatched`, and `invalid` D1 reservation states.
`dispatched` covers both an accepted command and active execution; DO state describes the step.
The old public `POST /api/admin/crawl` is blocked by `src/index.ts`, regardless of bearer token.

## Bounded work and persistence

- The owning DO fetches and parses one listing page in the same Alarm, then atomically commits its
  products, discovered frontier and session progress. No successful listing HTML is retained.
  This removes the intermediate fetched-page/session UPDATEs and the extra parse Alarm; it does
  not combine multiple pages into one invocation. The standalone executor retains the split path,
  and a pre-deployment `fetched` row still resumes through parse without another seller request.
  Terminal cleanup clears staged products.
- A crash before that atomic commit may require one normally paced seller retry. A crash after
  the commit resumes from the recorded result without refetching or incrementing counters twice.
  Partial collection never publishes inventory; the existing coverage/deactivation guards apply.
- Evaluate combined parsing on the DO execution boundary, not against the HTTP Worker's CPU
  allowance. Cloudflare documents a default 30-second CPU limit per DO invocation, including
  Alarms ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)); this does
  not justify moving collection back into Cron or HTTP requests. Keep the offline parser regression
  gate and inspect actual `exceededCpu`/CPU metrics after deployment.
- Detail enrichment plans the run once. `src/crawler/detail-enrichment-plan.ts` stores immutable
  target chunks separately from compact cursor/progress state, including an explicit empty-plan
  state. An Alarm reads its current chunk rather than rewriting/reloading the full plan.
  New chunks also retain only the extractor's source ID, model and title alongside each URL.
  The original URL list and plan instant remain readable by older releases.
- The detail row in `crawl_fetch_pages` is the durable fetch fence, accessed through
  `src/db/crawl-fetch-detail-repository.ts` (`crawl_fetch_detail_pages` is a compatibility view).
  New detail attempts store versioned category evidence (including an empty successful result),
  errors and the original fetch time, rather than HTML. Finalization consumes that evidence and
  combines it with each listing's own seller facts. Old in-flight plans without extractor inputs
  keep the legacy HTML path until they finish; existing saved HTML is still readable.
  If a process dies after saving a result and
  before advancing the DO cursor, the next Alarm consumes the saved result without a seller refetch.
  Preserve positive and negative evidence caching and its original decision time.
- R2 retains selected diagnostic/verification evidence under the existing caps, deduplication and
  lifecycle policies. A listing parser failure can archive the real failed HTML under a separate
  deadline. Staged publication never archives its synthetic HTML wrapper as seller evidence.
  Normal success adds no R2 object. See [R2 evidence safety](./r2-evidence-safety.md).
- Frontier reads use resumable state counters and the nonempty-page partial index from migration
  0083, avoiding repeated walks over an accumulated prefix of empty pages.
- Listing changes enqueue durable projection work in `crawl_run_work_items` / `crawl_run_stages`.
  The bounded stage runner and scheduled continuation use persisted listings without seller I/O.
  Cursor advancement follows successful writes; retries replay an idempotent chunk. A newer crawl
  adopts unfinished projection work before an older run is retired.
- `last_success_at` is collection freshness; `last_projection_at` advances only when derived work
  finishes. Health evaluates projection lag independently of collection freshness. Listing
  `last_seen_at` heartbeats may be throttled by `PRODUCT_TOUCH_INTERVAL_MINUTES`; they are not a
  replacement for either shop watermark.

General Cron serializes watchdogs and maintenance under the budget in `src/db/invocation-budget.ts`.
`scheduled_maintenance_pending` retains due tasks across yields, with finalization calls reserved
and still metered. Current-work recovery and cleanup selectors are indexed rather than scanning
all historical runs. See [Data platform architecture](./data-platform-architecture.md) for dirty-set
repair, count/price projections, and D1 accounting limits.

## Recovery

The central scheduler periodically scans dispatch reservations. If `dispatch_last_sent_at` has been quiet longer than the configured recovery interval, it re-delivers the same immutable `dispatch_token` to the same per-shop Durable Object and advances only `dispatch_last_sent_at`.

Time never creates a new logical child while a valid reservation exists. A new generation can be reserved only after the previous exact token is released.

A repeated delivery is safe:

- if the Durable Object still owns that token, `/start-crawl` is idempotent and re-arms its Alarm;
- if another token is active, the Durable Object returns `409 scheduler busy`;
- if D1 no longer owns the delivered token, the executor returns `stale_dispatch` without crawling.

## Seller pacing

### Direct shops

A direct request is prepared first. The permit records `notBeforeMs` and the effective delay. The Durable Object persists the permit, schedules an Alarm, and performs network I/O only after the permit becomes eligible.

### Relay shops

Relay transport follows the same lifecycle: PREPARE obtains a bounded permit, the Durable Object waits via Alarm, and FETCH consumes that permit. Expired permits are re-prepared. Relay configuration must never fall back to active sleep or to a crawl Queue lane.

## Queue boundary

Crawl control state must not be written by a Queue consumer. Crawl Queue bindings, fast/heavy/relay crawl lanes, and Queue-quota-based routing are retired.

Queues may still be used for post-commit asynchronous domains that have their own correctness model. Their quotas are operational alerts only. A Queue quota alert must not silently switch crawl execution paths or change crawl concurrency.

## Observability

Production dashboards and alerts should separate crawl-control cost from post-commit Queue health. Track at least:

- `do_requests/day`
- `do_duration_gb_s/day`
- `alarm_invocations/day`
- `alarm_writes/day`
- crawl pages/day
- `active_ms/page` and `active_ms/step` from structured crawl events
- dispatch recoveries/day (`crawl_dispatch_recovered`)
- dispatch recovery failures/day (`crawl_dispatch_recovery_failed`)
- `crawl_do_busy` count
- `crawl_do_alarm_failed` count
- completed / failed crawl runs by shop

For Relay shops also track prepared, expired/re-prepared, completed, and failed seller requests. A rise in Alarm invocations without corresponding page progress indicates a control-plane loop; a rise in active milliseconds per page indicates real work or network/database cost rather than Alarm waiting.

Queue dashboards for Knowledge Catalog/Product Audit should continue to expose outstanding/error/quota signals, but those signals are not crawl-routing inputs.

## Runbook

### A shop remains dispatched with no progress

1. Confirm the current `dispatch_token`, `dispatch_requested_at`, and `dispatch_last_sent_at` in D1.
2. Check `crawl_do_accepted`, `crawl_do_step`, `crawl_do_retry`, and `crawl_do_alarm_failed` for that shop/token.
3. If the quiet interval has elapsed, confirm the scheduler emitted `crawl_dispatch_recovered` with the **same token**.
4. If recovery repeatedly fails, fix the Durable Object or transport error. Do not manufacture a second token to bypass the reservation.
5. Administrative clearing is a last resort. Clear a dispatch only after confirming that the per-shop Durable Object has no active execution for that token; otherwise a live execution could lose its generation fence.

### `409 scheduler busy`

A busy response means the Durable Object already has an active generation. The dispatcher releases the newly attempted reservation. Inspect the active DO token and allow its Alarm/recovery path to continue. Do not route the request to a Queue as a fallback.

### Alarm failures

Alarm exceptions intentionally keep Durable Object execution state and the D1 reservation so Cloudflare can retry the Alarm. Diagnose the structured `crawl_do_alarm_failed` event. Avoid clearing D1 state merely because one Alarm invocation failed.

### Relay permit expires

The Durable Object discards the expired permit, prepares a new permit, and schedules another Alarm. Repeated expiry usually indicates excessive scheduling delay or Relay availability issues. Do not bypass PREPARE/FETCH pacing.

### Queue quota or backlog alert

Determine which post-commit domain owns the Queue. A Queue quota failure is not a reason to move crawl control back to Queue, change crawl lanes, or skip the Durable Object. Repair or defer the affected post-commit workload independently.

## Deployment and migration safety

D1 migrations run before Worker deployment, so a migration that removes columns still used by the currently deployed Worker is unsafe.

Migration 0072 introduced `dispatch_*` and a temporary compatibility bridge. Migration 0073 removes
that bridge and the old `queued_*` / `crawl_lease_*` columns. The current schema has completed this
retirement; shadow flags and Phase 0/1 Queue rollout instructions are no longer operating procedures.

A rollback must remain compatible with the migrated schema and the DO control plane. Do not roll
back to a Queue consumer that expects removed columns. Follow the same add/deploy/retire sequence
for future control-state changes and verify the deployed SHA before removing compatibility state.
