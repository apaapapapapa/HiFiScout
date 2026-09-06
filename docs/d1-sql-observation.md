# D1 SQL observation archive

Production SQL statistics are copied from **Cloudflare D1 Insights** to the dedicated, private R2
bucket `hifiscout-d1-observations`. Collection runs outside the application in the
`d1-sql-archive` job of `Production Operational Health`: every 15 minutes, on manual invocation,
and after successful **or failed** `Deploy Cloudflare` runs. Scheduled runs do not run the other
health jobs, crawl convergence checks, repairs, or queries against D1.

This deliberately adds **no SQL, instrumentation, storage calls, Queue messages, or CPU work to
the application Worker**. Collection uses Cloudflare control-plane/Analytics APIs; the application
can have an exhausted D1 quota or failed deployment while archived files remain readable from R2.
Collection can still fail when Cloudflare's Analytics/R2/control plane is unavailable or its API
token lacks access. Such failures are red workflow jobs, never successful empty archives.

## What is recorded

- SQL templates, SHA-256 template fingerprints and number of raw SQL variants represented.
- Execution count, rows read, rows written, rows returned and total SQL duration reported by Insights.
  Missing metrics stay `null`, not a misleading zero. Average duration can be computed as
  `durationMs / count` when both metrics are known and count is positive.
- Database ID resolved from the **active** public Worker's `DB` binding, UTC hour boundaries,
  collection timestamp and collector commit. Worker deployment version IDs are collector-time
  context, **not proof that every recorded query came from that Worker/version**. D1 Insights can
  include queries issued by maintenance/CI/REST clients as well as the application's HTTP, Cron,
  Queue, Durable Object and admin RPC paths.
- Coverage information: adaptive source sampling, top-group limits, inconsistent overlapping
  results, and query groups omitted to fit the bounded archive. Totals describe the observed groups,
  not a guarantee of complete account-wide billing.

Cloudflare does not include bound parameters in D1 Insights. The collector additionally removes
inline string/blob/numeric literals and comments **before** storage or fingerprinting. SQLite
accepts double-quoted string literals, so all quoted tokens, including quoted identifiers, are
conservatively replaced. Result rows, authentication data and raw API errors are never stored.
CI output contains only aggregate metrics, coverage and R2 keys, **not SQL text**. There is no
public application route for this bucket and collection does not enable public R2 access.

## Semantics and limits

This is a **SQL-level aggregate archive, not a lossless per-execution audit log**. Native adaptive
sampling, source availability and delivery delays apply. It cannot reconstruct the bind values,
exact order of individual calls, per-request correlations, transaction boundaries or SQL-specific
error messages. In particular, queries rejected before Insights records them may be absent. Use
Workers Logs/traces for invocation exceptions, CPU exhaustion and request correlation; do not infer
that an SQL did not execute merely because it is absent from this archive.

Each collection reads the current UTC hour plus the preceding two hours. Each hour is requested
with equal `datetimeHour_geq` and `datetimeHour_leq` filters, rather than an overlapping inclusive
next-hour boundary. Current-hour statistics are provisional. Re-reading recent hours accommodates
late telemetry; delays longer than this lookback need a manual recollection while Insights still
retains the data. GitHub scheduled workflows are best effort and can start late or skip a run.

Each hour is queried in four rankings (reads, writes, duration, count), at most 500 groups per ranking.
Identical raw query groups appearing in several rankings are counted once. Literal-only variations
are then merged by the redacted template. A ranking reaching its limit is explicitly reported as
potentially incomplete. Conflicting copies of a group are not added together; the first observation
is retained and the inconsistency count is recorded.

R2 keys are `sql/v1/<database-id>/<YYYY-MM-DD>/<HH>.json.gz`. A later snapshot **replaces** that hour;
snapshots must never be added together as independent time intervals. Analysis also deduplicates
same-hour snapshots by collection timestamp. The first deployment only starts this archive; it does
not automatically reconstruct earlier days.

SQL text is capped at 16,000 characters (with a truncation flag). Each archive is capped at 4 MiB
uncompressed / 1 MiB compressed. When necessary, low-ranked templates are omitted, while their
metrics remain in observed totals and their number is recorded. A named R2 lifecycle rule deletes
objects 5 days after their last write; unrelated lifecycle rules are preserved. Deletion is
asynchronous, so this is an automatic expiration policy, not a guarantee of deletion at an exact
second. Recollecting an hour replaces its object and restarts its age.

For one database, five days of hourly object keys hold at most **120 MiB** of payload, even if every
object reaches its maximum, plus recent rewrites and objects awaiting asynchronous expiry.
A usual 15-minute run writes three objects and
reads them back: about 8,640 PUTs and 8,640 read-backs per 30 days, plus manual/deploy-triggered runs.
These are workload bounds, **not a promise that the entire account stays within its free tier**;
R2 usage is shared with other buckets. No D1 metadata table or R2 listing scan is used for bookkeeping.

## Operation and incident analysis

Use the already-configured `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; do not put tokens in
command arguments or commit them. Required API access includes reading Worker bindings/deployments,
account Analytics, and R2 object/bucket/lifecycle operations. A 401/403 fails closed without trying
other credentials or silently changing the data source. The collector provisions its dedicated
bucket and retention rule after confirming Insights access.

To recollect a recent period (up to 24 hour buckets per invocation):

```sh
vp exec tsx scripts/archive-d1-sql.ts --hours 3
vp exec tsx scripts/archive-d1-sql.ts --at 2026-09-06T02:00:00Z --hours 6
```

`--at` selects the observation window, not the collection timestamp: recollections record when they
actually ran so that the newest snapshot can be identified correctly.

To analyze saved data, without querying D1 or Insights:

```sh
vp exec tsx scripts/analyze-d1-sql.ts --at 2026-09-06T02:00:00Z --hours 6 --database-id <archived-database-uuid>
```

The output is JSON with totals, missing hours, per-hour coverage and the top 20 SQL templates by
reads, writes, duration and count. With `--database-id`, analysis does not even need the Worker to
exist. Without it, only the active binding/deployment control-plane metadata is consulted to
resolve the database; data still comes exclusively from R2. UTC is used in file names and output
(JST is UTC+9). To inspect several days, analyze bounded day windows separately.

Use the archived template to locate repository code. Do not replay the stored SQL automatically:
literals and quoted identifiers have been removed and writes could change production data. Read
query plans against a safe local fixture, then compare observed read/write costs after a change.

## Verification

Every successful archive job reads back each R2 object and verifies its database, hour and collection
timestamp. Unit tests cover privacy redaction, overlapping rankings/snapshots, missing metadata,
bounded storage, failed APIs, lifecycle reconciliation and the complete mocked collection/read-back
flow. These tests never call production or retailer sites.

Authoritative references: [D1 metrics and query Insights](https://developers.cloudflare.com/d1/observability/metrics-analytics/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/), and
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).
