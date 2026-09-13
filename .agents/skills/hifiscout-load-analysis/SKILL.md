---
name: hifiscout-load-analysis
description: "HiFiScoutのD1クエリ最適化と、D1・Queue・Workers/DO CPUの負荷原因・改善効果の分析に使う。"
---

# HiFiScout load analysis

Select the evidence needed for the claim; code optimization need not start with a production audit.

| Work | Reference |
| --- | --- |
| Production SQL/billing observation | [D1 SQL observation](../../../docs/d1-sql-observation.md) |
| Query/projection design | [data-platform architecture](../../../docs/data-platform-architecture.md) |
| Local cost regression | [testing strategy](../../../docs/testing-strategy.md#free-tier-performance-regressions) |
| Existing CI samples/comparisons | [harness cost evidence](../../../.github/harness/README.md) |

## Interpret observations

Use existing artifacts, R2 archives and native telemetry before application-table scans. Prefer
public-safe `d1-sql-load-report` artifacts or `D1_SQL_LOAD_REPORT` log lines; raw SQL templates/archives
stay private. Use `scripts/analyze-d1-sql.ts` only for needed private detail after checking its options.

Record database, UTC interval, collection time, serving identity, workload denominator and coverage.
Deduplicate database/hour snapshots; do not sum overlapping rolling reports. Missing hours, provisional
buckets, sampling, top-group limits and quota gaps constrain the claim even with every archive present.
Missing metrics remain `null`, never zero. Collector SHA/collection-time version cannot attribute every
SQL execution to that version; admin, maintenance and CI also use D1. CPU claims need invocation/CPU
telemetry (including `exceededCpu`); SQL duration and wall time measure different things.

## Optimize the owning path

Trace costly fingerprints to current callers and distinguish per-execution cost from frequency.
Evaluate reads, writes, statement count and query plans with realistic unrelated inventory/history
and changed/unchanged cases. `LIMIT`, a small result, an index or fewer bindings alone proves no bound;
include projection/index/trigger maintenance and work moved to Queue, R2, DO storage or CPU.

Preserve same-value zero-write guards, decision times, filtered INSERTs avoiding AUTOINCREMENT writes,
durable cursors and recovery after crashes/concurrent edits. Use indexed bounded windows and dirty-key
projections; budget exhaustion must not create unbounded retries or request-time full aggregation.
Account for continuation, retries, duplicate delivery, DLQ and finalization. Identify the actual Queue
producer: per-shop DOs own crawls. Migration changes also need old/new runtime compatibility evidence.

Reuse matching CI/harness samples before another benchmark. `cost-report`/`compare-cost` preserve
source, fixture and runtime identity; a sample without its passing check is insufficient. Local D1,
mocked DO/Queue and Node CPU are separate evidence types, not production billing/CPU measurements.

## Complete the requested claim

A code fix needs relevant local regressions and delivery. A claimed production improvement also needs
disjoint comparable workload intervals, identified deployments and preserved inventory/grouping/progress.
Separate measured results, inference and missing evidence. Use accepted issue criteria for observation
windows; propose segmented/equivalent-change cohorts explicitly if needed, never silently substitute.
Keep paused audits paused; observation gaps do not authorize repair/replay. Stop collection when it
cannot improve coverage or reaches its budget. Do not claim both reads and writes fell without both.
