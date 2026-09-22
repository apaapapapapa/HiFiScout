# Preventing load regressions

The load contracts in `scripts/harness/load-contracts.ts` name each owning source boundary,
its behavioral suites, local measurement environment and absolute sample ceilings. A lower SQL
call count cannot compensate for more rows read or written. Zero-write replay includes index,
trigger and AUTOINCREMENT effects. A missing measurement is unknown, never a free operation.

## Capturing comparable evidence

On a clean checkout with the pinned toolchain and frozen dependencies:

```bash
vp run harness load-capture .generated/load-candidate
```

Use a new output directory. The command runs the existing contract suites and parser benchmark,
retains their real outcomes/logs and samples, and checks every required measurement and registered
ceiling. Normal CI collects the same samples from the unit shards; it does not repeat the candidate
tests. Sample profiles bind the fixtures/helpers, dependency lock, Node version, OS and architecture.
Use identical profiles for `compare-cost`; changing a test or runtime cannot establish improvement.

## Required PR and main comparison

CI's `load-baseline` job checks out the exact PR base (or previous main push), installs that
revision's pinned dependencies and executes `load-capture`. The candidate reuses D1/DO/Queue samples
and real Vitest outcomes from the existing four shards; there is no second candidate unit-test run. The required
`product-replay` job runs `load-gate`, and `fan-out` requires both jobs to succeed. Markdown-only
changes retain the existing lightweight path.

The gate checks source identity, all required old/new sample IDs, original test setup/teardown and
assertion outcomes, absolute ceilings, relative cost and changed-source coverage. Row/statement/
message increases have no implicit allowance. CPU is measured separately by `load-cpu`: clean base
and candidate checkouts run alternately on the same runner, with three fixed sessions per revision.
The gate compares their medians with the existing relative noise allowance and each revision's
unchanged parser ceilings. Every session must complete with valid fixtures and measurements; failed
runs are never retried until green or discarded. The original CI parser gates remain required.
Cross-job single CPU observations and absolute Node CPU remain diagnostic. A new or moved
DB/crawler/background-work path without an owning
contract fails. Direct DB/storage access added elsewhere in `src` is also treated conservatively.
Registration maps a boundary to maintained tests; it does not prove execution coverage of every
branch. Add a representative measured scenario when adding a new operation, not just a filename.

CI retains `load-baseline` and `cost-evidence` (including `load-gate.json`) for 30 days. Missing,
failed, stale, dirty, skipped and incomparable observations fail the gate. Never replace a failed
baseline run with a fabricated observation or a different source SHA.

For a local CPU pair, prepare a clean baseline worktree and install its frozen dependencies, then
run `vp run harness load-cpu <baseline-checkout> .generated/load-cpu`. To assemble the complete gate,
use `vp run harness load-gate <base-sha> <baseline-capture-dir> <candidate-samples-dir>
<paired-cpu-dir> <output.json> <vitest-reports...>`. Reports must include the registered contract and
harness guard suites. `cost-evidence` preserves all six raw CPU sessions, logs and the paired capture;
the gate never rewrites the original per-job cost samples.

### Intentional workload or baseline changes

When a new feature legitimately changes a workload, retain both complete measurements and explain
the expected increase in the PR. A policy/profile change requires an explicit entry in
`.github/harness/load-reviews.json`, reviewed with the implementation. `load-gate.json` provides
`policyDigests` and each sample's `beforeDigest`/`afterDigest` for this purpose. An entry contains:
`id` (sample ID or `load-contracts`), exact `baseSha`, both digests, a substantive `reason`, and
`evidence` links to this repository's PR, workflow artifacts or committed evaluation.

The record binds exact profiles, deterministic observations and ceilings to one base revision.
It cannot waive a missing required sample or absolute ceiling, unknown metric, failed/skipped test,
unknown owning boundary, substituted CPU measurement environment or absolute overrun. A same-profile
CPU regression remains a failure. An accepted fixture
change is reported as `reviewed_baseline`, preserving the original unknown comparison; it is never
reported as measured improvement. Do not generate review records automatically when a gate fails.
An added case needs measured absolute limits and its reviewed initial baseline; retain existing
cases so removing a test cannot silently remove a requirement.

## Covered workload shapes

- Catalog hydration: 40 fixed IDs at 100, 1,000 and 10,000 unrelated catalog rows.
- Retention: 500 parent deletions with 100, 1,000 and 10,000 unrelated foreign-key child rows.
  The original pre-index incident reproduction remains in the same suite.
- Search: complete selective counts, pages and offer loading over 10,000 listings.
- Listing replay: unchanged product/metadata/projection publication with zero physical writes.
- Scheduling: every configured Cron firing over a whole UTC day, per-shop dispatch counts and
  the sum of configured initial-page ceilings, including disabled shops conservatively.
- Continuation: six budgeted invocations complete 25 durable work units, allow an untouched task
  to proceed and count claim/watchdog/finalization overhead. Separate existing tests cover failed
  D1 calls, batch transactions, Queue redelivery and DO crash recovery without another seller fetch.

The schedule scenario is a frequency/page allowance, not a measured whole-day read/write estimate.
It excludes detail fetches and retries, which retain their separate behavioral budgets. A new shop,
cadence, batch size or retry path must bring corresponding workload evidence. The shared invocation
budget rejects non-finite/invalid limits, yields between useful units and keeps reserved finalization
metered. Use it and the existing durable cursors rather than restarting completed work.

## Review and production evidence

For a DB, migration or background-work change, identify the affected contract and demonstrate:
unchanged work, a real change, unrelated data growth, and recovery from interruption as applicable.
Extend the owning regression when fixing a load incident. Explain any ceiling, workload, fixture or
dependency change with old/new measurements; never regenerate a baseline just to turn a gate green.
Tests must also preserve results, freshness decisions and committed progress.

Local workerd row counters, mocked DO/Queue calls and Node relative CPU remain distinct. They do not
prove production billing, Workers CPU or account-wide free-tier fit. Follow
[D1 SQL observation](./d1-sql-observation.md) using the existing passive Analytics/R2 archives;
compare non-overlapping workload-normalized intervals and retain coverage/deployment identity.
Missing, sampled, provisional and quota-gap data cannot prove zero usage. Keep paused active audits
paused. Collection and alerting must not add per-query D1 writes or full-table scans.
