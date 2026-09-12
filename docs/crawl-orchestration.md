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
8. The Durable Object stores the collection cursor and counters with its next command. D1 page rows retain committed payloads and recovery receipts; the session receives a summary before finalization. The dispatch token fences delayed or replayed `/start-crawl` deliveries so an older generation cannot execute a newer reservation.
9. A terminal crawl releases only its exact D1 dispatch token. A continuation or retry keeps the reservation.

The Durable Object is the single-flight authority. D1 does not maintain a second execution lease. The D1 dispatch row is a generation fence and scheduler recovery marker, not a Queue-consumer lease.

`src/crawler/crawl-lifecycle.ts` exposes `idle`, `dispatched`, and `invalid` D1 reservation states.
`dispatched` covers both an accepted command and active execution; DO state describes the step.
The old public `POST /api/admin/crawl` is blocked by `src/index.ts`, regardless of bearer token.

Inventory recheck reads one stale candidate per successful crawl through the same paced request.
AudioUnion's listing status field is authoritative: a retained price or a related item's purchase
button does not prove availability. An explicit sold observation sets `stock_status` to `sold_out`
immediately; deactivation still requires the configured consecutive failure threshold. Missing
pages retain the repeated-observation rule, and transient errors never imply a sale. The already
fetched listing fields can update structured offer facts without another HTTP request. The existing
checked-result finalization refreshes the affected listing's public search projection.

## Daily shop schedules

Shops without a dedicated `scheduleCron` receive **two automatic crawl slots per day**. The shared
ten-minute trigger walks the stable plugin registry once from **11:00 JST** and once from
**17:00 JST**. Each pass stops after the last shop; remaining ticks are idle without touching D1.
Disabled shops keep their slot and remain disabled; they do not shift the other shops' start times.
The selection uses the scheduled event timestamp, so delivery delays do not change the assigned
shop or restart a pass. The trigger runs at exact ten-minute boundaries, starting at 02:00 UTC
(11:00 JST), and stops before the overnight pause.

AudioUnion, HiFiDo and Fujiya Avic retain their dedicated schedules. The current expressions and
shop inventory live in `src/crawler/shops/index.ts` and `wrangler.jsonc`; selection policy lives in
`src/crawler/schedule.ts`. Twice-daily shops use a nominal 720-minute interval for health and
interval-based eligibility. Scheduled dispatch uses the fixed slots, not a rolling 12-hour check:
the gap is six hours from the first pass to the second and eighteen hours until the next day's
first pass. An active dispatch still blocks a new generation. Recovery and continuation resume
the same generation; they do not add another crawl. Explicit manual dispatch remains available
during allowed hours.

## Overnight pause

All shops pause collection every day from **23:00 JST (inclusive) to 08:00 JST (exclusive)**.
The policy lives in `src/crawler/crawl-window.ts`; crawl Cron hours in `wrangler.jsonc` use UTC.
The daily and dedicated schedules above apply during allowed hours. Missed nighttime slots are
not replayed, and seller pacing is unchanged.

- Scheduled, forced/manual and recovery dispatches skip the pause before reading or writing D1.
  Cron checks both the scheduled timestamp and delivery time to handle delayed events.
- A running `CrawlScheduler` keeps its dispatch token, cursor, prepared permit and collected data.
  Its next Alarm is deferred until 08:00 JST. Older or retried Alarms delivered during the pause
  only re-arm that Alarm; they perform no seller or D1 work. An already-started bounded step may
  finish, but no new step starts overnight. Expired Relay permits are re-prepared after resumption.
- The five-minute general Cron still runs health and independent maintenance, including post-commit
  projections and exports. Its crawl watchdog does not redeliver paused executions overnight.
- Collection freshness thresholds exclude planned pause time while public `ageMinutes` still
  reports actual elapsed time. Real failures, missing configuration and stalled post-commit
  projections remain visible; projection lag uses wall-clock time because maintenance continues.

## Bounded work and persistence

### Administrative controls

The Access-protected admin console exposes `/api/admin/crawls` and `/api/admin/crawls/control`
through `CatalogAdminService`. The overview reads the small shop-state table once and each shop's
compact DO status, with at most four concurrent status calls. It shows observation/progress times,
the next registry-derived schedule slot, last success, prior-success inventory delta, projection
watermark, failure/backoff information and explicit manual/overnight pause states. No listing counts
or crawl-history aggregation run on navigation; the view refreshes only on entry or user action.

Manual pause first persists the owning DO's local alarm gate, then D1 scheduling intent. New
reservations and watchdog recovery skip paused shops. Alarms check the local gate without D1 or
seller I/O, preserving the exact execution, cursor, token and prepared permit. Resume persists
scheduling intent before opening the local gate; a lost response can safely be retried. A bounded
step already in progress may finish. Pause is separate from deployment configuration and daily
quiet hours; resuming cannot bypass the nightly window or the PREPARE/FETCH pacing rules.

**途中から再実行** re-arms the current execution. If the DO record is missing but a D1 dispatch is
reserved, the command re-delivers that same immutable token. A new forced dispatch is allowed only
when neither exists and normal configuration/quiet-hour guards allow it. Internal DO control URLs
are reached only by the service, not exposed as public admin endpoints. A failed status read is
displayed as unavailable, not as an idle or healthy shop.

- The owning DO fetches and parses one listing page in the same Alarm, then atomically commits its
  products, discovered frontier and a progress receipt. No successful listing HTML is retained.
  This removes the intermediate fetched-page UPDATE and the extra parse Alarm; it does
  not combine multiple pages into one invocation. The standalone executor retains the split path,
  and a pre-deployment `fetched` row still resumes through parse without another seller request.
  Terminal cleanup clears staged products.
- A crash before that atomic commit may require one normally paced seller retry. A crash after
  the commit resumes from the recorded result without refetching or incrementing counters twice.
  Partial collection never publishes inventory; the existing coverage/deactivation guards apply.
- Direct permits are consumed in DO storage before seller I/O, so response decoding, discovery,
  parser CPU exhaustion or a failed D1 commit cannot reuse a spent permit. An uncommitted attempt
  requires a fresh PREPARE/delay; a committed page receipt resumes before any new seller I/O.
  This adds one small DO write per direct request, without adding D1 writes or a pacing sleep.
- Evaluate combined parsing on the DO execution boundary, not against the HTTP Worker's CPU
  allowance. Cloudflare documents a default 30-second CPU limit per DO invocation, including
  Alarms ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)); this does
  not justify moving collection back into Cron or HTTP requests. Keep the offline parser regression
  gate and inspect actual `exceededCpu`/CPU metrics after deployment.
- New executions use `progress_storage = 'durable_object'`. Combined fetch/parse, legacy split and ignored-page transitions
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
  New chunks also retain only the extractor's source ID, model and title alongside each URL.
  Version 3 uses separate plan keys so the older HTML-only Worker never inherits an advanced
  cursor for results it cannot read. Version 2 plans are adopted without replanning or changing
  their instant, while their original records remain available for rollback.
- The detail row in `crawl_fetch_pages` is the durable fetch fence, accessed through
  `src/db/crawl-fetch-detail-repository.ts` (`crawl_fetch_detail_pages` is a compatibility view).
  New detail attempts store versioned category evidence (including an empty successful result),
  errors and the original fetch time, rather than HTML. Finalization consumes that evidence and
  combines it with each listing's own seller facts. Old in-flight plans without extractor inputs
  keep the legacy HTML path until they finish; existing saved HTML is still readable.
  Structured results use a separate page-key prefix; the new fence reads both formats. On rollback,
  an older Worker can prepare and fetch missing HTML instead of silently skipping unreadable evidence.
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
and still metered. Before claiming a task, the scheduler requires its admission floor to remain:
eight D1 binding calls by default, and thirty-one (one claim plus thirty execution calls) for the
non-checkpointed data-quality remediation sweep. When fewer calls remain, the task stays unclaimed
and oldest in the pending queue for the next five-minute tick. This avoids writing a partial
projection that cannot reach durable job
completion in the same invocation; it does not change remediation cadence or results. Stalled
recovery explicitly uses `idx_crawl_runs_running_started_at`, excluding
terminal history even when statistics would select the older general date index. Deployment checks
explain the original and enforced access paths and execute only a five-row running-work probe.
Current-work recovery and cleanup selectors are indexed rather than scanning
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

### Bounded seller bodies

Every external body a transport reads is capped by `src/crawler/response-limits.ts`. The ceiling is
enforced on bytes actually read from the response stream, so it holds for a response with no
`Content-Length` and for a small compressed payload that expands after decoding; `Content-Length`
is only an extra early rejection. Past the ceiling the read is abandoned, the reader cancelled, and
no error path re-reads the body.

The same request deadline covers the body, so a seller that returns headers and then stalls fails
on the crawl's own timeout rather than holding the invocation open.

An oversized body raises `CrawlResponseTooLargeError` and fails the collection through the normal
failure path. It is never reported as a successful crawl with zero items, which is what would mark a
shop's existing products inactive. `robots.txt` is the one exception: RFC 9309 allows a parsing
limit, so an oversized policy is truncated at a line boundary instead of failing the crawl.

Fetch ceilings are independent of evidence retention (`EVIDENCE_MAX_BYTES`); how much may be
fetched and how much may be stored are separate requirements.

The AudioUnion relay Lambda applies its own ceiling before proxying, capped at 4 MB because a Lambda
Function URL response may not exceed 6 MB once base64 expands it. An oversized upstream returns a
relay failure (`502 upstream_response_too_large`, deliberately without
`x-hifiscout-upstream-status`) so the Worker fails the collection rather than recording an empty
seller page.

The `browser` transport renders in a remote browser session, so the Worker can only bound the HTML
that crosses back to it. The browser session's own buffering is a residual risk outside the
Worker's control; no shop currently uses that transport.

Knowledge Catalog verification (`src/catalog/knowledge-verification/http.ts`) reaches arbitrary
manufacturer sites and has always had its own byte and time budget
(`KNOWLEDGE_CATALOG_SOURCE_MAX_RESPONSE_BYTES`); it does not share these crawl transports.

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
