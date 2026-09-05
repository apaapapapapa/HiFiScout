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
   - initialize / fetch / parse / finalize,
   - staged category-detail fetch,
   - Relay inventory recheck.
6. Any seller pacing delay is represented by an Alarm timestamp. The control plane does not `sleep()` or hold an invocation open while waiting.
7. Direct and Relay HTTP both use PREPARE -> Alarm -> FETCH semantics. Relay permits can expire; an expired permit is discarded and prepared again rather than bypassing pacing.
8. The Durable Object stores the collection cursor and counters with its next command. D1 page rows retain committed payloads and recovery receipts; the session receives a summary before finalization. The dispatch token fences delayed or replayed `/start-crawl` deliveries so an older generation cannot execute a newer reservation.
9. A terminal crawl releases only its exact D1 dispatch token. A continuation or retry keeps the reservation.

The Durable Object is the single-flight authority. D1 does not maintain a second execution lease. The D1 dispatch row is a generation fence and scheduler recovery marker, not a Queue-consumer lease.

`src/crawler/crawl-lifecycle.ts` exposes `idle`, `dispatched`, and `invalid` D1 reservation states.
`dispatched` covers both an accepted command and active execution; DO state describes the step.
The old public `POST /api/admin/crawl` is blocked by `src/index.ts`, regardless of bearer token.

## Bounded work and persistence

- Listing pages persist a fetched payload before a separate parse step. Parsing clears listing HTML
  and stores products; terminal cleanup clears staged payloads. D1 staging supports recovery, while
  R2 is the retained diagnostic evidence store.
- New executions use `progress_storage = 'durable_object'`. Fetch, parse and ignored-page transitions
  put a compact, versioned receipt in `crawl_fetch_pages.progress_json` in the same D1 page update.
  After that transaction succeeds, the existing DO execution write atomically stores the next
  command, sequence, counters and coverage flags. There is no additional DO key write or Alarm for
  collection progress. Page HTML/products and the growing frontier never enter the DO execution value.
- The D1 session counters are a checkpoint, not live per-page progress for DO-owned collections.
  Before entering detail/finalize, and on a handled collection failure, the owner checkpoints the
  counters/coverage into D1. Finalization and complete-inventory decisions retain their existing
  D1 contract. Observe live progress through `crawl_do_step` logs rather than the D1 checkpoint.
- Detail enrichment plans the run once. `src/crawler/detail-enrichment-plan.ts` stores immutable
  target chunks separately from compact cursor/progress state, including an explicit empty-plan
  state. An Alarm reads its current chunk rather than rewriting/reloading the full plan.
- The detail row in `crawl_fetch_pages` is the durable fetch fence, accessed through
  `src/db/crawl-fetch-detail-repository.ts` (`crawl_fetch_detail_pages` is a compatibility view).
  If a process dies after saving a page and
  before advancing the DO cursor, the next Alarm consumes the saved result without a seller refetch.
  Preserve positive and negative evidence caching and its original decision time.
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

If D1 commits a listing page but the DO execution write is interrupted, the retried step reads that
exact page's receipt before fetch/parse. It restores the next command and counters without another
seller fetch, parse, discovery insertion or counter increment. A failed page transaction leaves the
old DO progress in place. Receipt identity and sequence must match the run/page generation; corrupt
or cross-generation progress fails closed. Recovery never searches the whole frontier.

Migration 0089 defaults existing sessions to `d1`. Already accepted executions without the DO
progress field finish through the legacy atomic page/session update path; only newly accepted
executions opt in. Keep the `phase2_crawl_execution` key stable. Deploy the additive migration before
the Worker. After DO-owned runs start, prefer a forward fix: rolling back to a Worker that predates
this progress format requires stopping new dispatch and draining the active DO-owned runs first.
Deleting DO state is not a rollback procedure.

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
