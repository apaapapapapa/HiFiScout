---
name: hifiscout-load-analysis
description: "HiFiScoutのD1 Read/Write、Queue、Workers/DO CPU、R2 SQLログから負荷原因と改善効果を分析する。Use for query/schema optimization and operational load evidence, not ordinary UI changes with no data-cost impact."
---

# HiFiScout load analysis

## Establish observation coverage

Read [D1 SQL observation](../../../docs/d1-sql-observation.md),
[data-platform architecture](../../../docs/data-platform-architecture.md) and the relevant
[workflow owner](../../../.github/workflows/README.md). Start with existing artifacts, saved R2
archives and native telemetry rather than application-table scans.

- Record the UTC interval (label JST conversions), active database, source/serving deployment
  identity, workload denominator, workflow/job conclusion and collection timestamps.
- Prefer the public-safe `d1-sql-load-report` artifact or `D1_SQL_LOAD_REPORT` job-log line for
  GitHub evidence. Use `scripts/analyze-d1-sql.ts` only when private SQL-template detail is needed;
  keep raw SQL/archive contents out of public PRs and reports. Inspect command options before use.
- Deduplicate hourly snapshots by database/hour and collection time. Do not sum overlapping
  rolling reports. Check missing hours, provisional buckets, sampling and top-group limits.
  Complete archive availability does not establish complete billing coverage.
- Keep missing/quota-blocked metrics unknown (`null`), with a reason. Never infer zero load from
  absent traces, expired artifacts or a successful empty/deferred workflow.
- Attribute CPU using invocation outcomes and CPU telemetry, including `exceededCpu` and other
  available failures. SQL duration and wall time are not Workers/DO CPU measurements. An archive's
  collector commit or collection-time Worker version cannot attribute every SQL to that version;
  maintenance, admin and CI also use D1.

## Trace and reduce work

Rank SQL fingerprints by observed total reads, writes, duration and count. Locate their current
code owners with `rg`, then follow the caller and invocation boundary. Distinguish per-execution
cost from excessive frequency. Identify the specific expensive access path before proposing a fix.

Compare `rows_read`, `rows_written`, statement count and query plans using the existing local D1
budget tests in [testing strategy](../../../docs/testing-strategy.md). Use realistic unrelated
inventory/history sizes and both changed/unchanged cases. A short result, `LIMIT`, fewer bindings
or a view does not itself prove fewer reads; include projection/index/trigger maintenance writes.
SQLite plans and local workerd metrics support the implementation claim, not production billing
or CPU effectiveness. Require evidence before claiming both total reads and writes decreased.

Reuse current [harness cost evidence](../../../.github/harness/README.md) and CI samples before
running another benchmark. `cost-report` and `compare-cost` preserve source/fixture/environment
identity; consult their current commands and sample requirements. Local D1 metadata, mocked
DO/Queue calls and Node parser CPU are different evidence types. A sample file alone does not
prove its test passed, and changing fixtures/dependencies cannot manufacture an improvement.

Prefer bounded candidate windows, indexed access, durable cursors and dirty-key projection work.
Preserve same-value zero-write behavior, original decision times, filtered INSERT guards and
recovery after a crash or concurrent edit. Add schema changes as new migrations and verify old/new
runtime compatibility when the changed boundary requires it. Do not solve budget exhaustion with
an unbounded batch, raised limit, full rescan on every retry or request-time catalog aggregation.

Account for the whole job lifecycle: continuation wakes, retries, duplicate delivery, DLQ work,
finalization and maintenance. A single initial Queue message is not a one-message job. Crawls are
owned by per-shop Durable Objects; identify the actual Queue producer before attributing backlog.
Check whether a proposed D1 reduction adds Queue, R2, DO storage or CPU work elsewhere.

## Judge the result

Compare disjoint, workload-comparable intervals and label mixed deployments. Preserve correctness:
inventory completeness, safe grouping, pending projections and progress must not regress. If
continuous releases prevent a fixed-version baseline, use the latest issue's accepted criteria;
propose deployment-segmented or equivalent-change cohorts with explicit exclusions and coverage
only as an alternative, not as silently satisfied acceptance.

Report measured results, local evidence, inference and missing production evidence separately.
Keep paused D1-backed health/audit jobs paused; passive archive collection is a different workflow.
Use existing authorization for requested repairs, but do not launch production repair/replay merely
to fill a measurement gap. Stop repeated collection when it cannot improve coverage or reaches the
documented budget. Use delivery routing for code changes and issue triage for acceptance decisions.
