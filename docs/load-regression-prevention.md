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
