# Export job lifecycle refactoring evidence — 2026-09-22

- Baseline: `c98bc5017fb7c520b9fac537a525ae3e9d6385b0`.
- Measured candidate: `835d496c8fea2131e2a9a90bf89e3831f4c89849` (published implementation commit).
- Both captures used clean checkouts, locked dependencies, Node 22.23.2, npm 12.0.2 and Vite+ 0.2.9.
- `vp run verify`: 427 suites / 2,445 tests pass, plus formatting, lint, strict types, architecture and parser checks.
- Existing focused export suites: 47 tests pass. Load captures: baseline 111 tests, candidate 143 tests, both pass. Load harness guard suites: 19 tests pass.
- Candidate capture adds four existing export/recovery suites; no test implementation, fixture, sample, ceiling or runtime dependency changed.
- All 16 extracted SQL statements match their original statements after normalizing whitespace and replacing the fixed table identifier. Parameter order, lease/cursor fences, retention and deadlines are preserved.
- Source implementation decreases by 206 lines across the two repositories and the shared lifecycle.

## Reproduction and limits

```sh
vp run verify
# In separate clean baseline/candidate checkouts:
vp run harness load-capture .generated/export-lifecycle-baseline
vp run harness load-capture .generated/export-lifecycle-candidate
vp run harness compare-cost <baseline>/samples <candidate>/samples
vp run harness load-cpu <baseline-checkout> .generated/export-lifecycle-cpu
```

The independent single-session comparison returned `fail` for `cpu-dynamic-audio-normalize`: relative CPU 189.03 → 863.81 (4.5697×). That observation is retained here. It was followed by the existing fixed same-runner alternating three-session procedure, whose complete median comparisons are below; no individual round was retried or discarded. The PR/main CI load gate remains authoritative for its own exact tested SHA.

These are offline local workerd/mocked Queue/Node observations. Production CPU, billing and traffic were not measured. The ownership registration below does not waive missing measurements or an exceeded ceiling.

## Deterministic samples

All 23 samples have identical before/after profiles and measurements. Values below are the independently observed value in **each** capture.

| Sample | Environment | Metrics in both captures |
| --- | --- | --- |
| `auction-admin-status` | local-workerd | rowsRead=8002, rowsWritten=0, sqlStatements=6 |
| `auction-catalog-replay` | local-workerd | rowsRead=4, rowsWritten=0, sqlStatements=3 |
| `auction-catalog-shared` | local-workerd | rowsRead=17, rowsWritten=0, sqlStatements=8 |
| `auction-price-change` | local-workerd | rowsRead=3, rowsWritten=5, sqlStatements=2 |
| `auction-replay` | local-workerd | rowsRead=2, rowsWritten=0, sqlStatements=1 |
| `auction-search-filtered` | local-workerd | rowsRead=12001, rowsWritten=0, sqlStatements=2 |
| `auction-search-page` | local-workerd | rowsRead=53, rowsWritten=0, sqlStatements=2 |
| `catalog-rows-100` | local-workerd | rowsRead=120, rowsWritten=0, sqlStatements=2 |
| `catalog-rows-1000` | local-workerd | rowsRead=120, rowsWritten=0, sqlStatements=2 |
| `catalog-rows-10000` | local-workerd | rowsRead=120, rowsWritten=0, sqlStatements=2 |
| `category-prune` | local-workerd | rowsRead=241, rowsWritten=0, sqlStatements=1 |
| `crawl-checkpoint-inline` | local-workerd | rowsRead=196, rowsWritten=176, sqlStatements=59 |
| `crawl-checkpoint-split` | local-workerd | rowsRead=316, rowsWritten=256, sqlStatements=99 |
| `crawl-do-retry` | local-mock | doAlarms=3, doStorageWrites=2 |
| `daily-schedule` | local-mock | scheduledInvocations=391, crawlDispatches=61, plannedPages=1619 |
| `maintenance-continuation` | local-mock | d1Calls=49, sqlStatements=49 |
| `projection-unchanged` | local-workerd | rowsRead=109, rowsWritten=0, sqlStatements=34 |
| `queue-export-redelivery` | local-mock | queueSends=0, queueRetries=0 |
| `retention-history-100` | local-workerd | rowsRead=2528, rowsWritten=500, sqlStatements=10 |
| `retention-history-1000` | local-workerd | rowsRead=2528, rowsWritten=500, sqlStatements=10 |
| `retention-history-10000` | local-workerd | rowsRead=2528, rowsWritten=500, sqlStatements=10 |
| `search-new-total` | local-workerd | rowsRead=145, rowsWritten=0, sqlStatements=5 |
| `search-price-drop-total` | local-workerd | rowsRead=181, rowsWritten=0, sqlStatements=5 |

## Fixed paired CPU comparison

All six sessions succeeded, all unchanged absolute ceilings passed, and all eight common-reference median ratios passed. These variations are not evidence of a production performance improvement.

| Stage | Baseline median μs | Candidate median μs | Ratio | Maximum ratio |
| --- | ---: | ---: | ---: | ---: |
| `cpu-dynamic-audio-discover` | 6.242 | 5.145 | 0.824255 | 2.604701 |
| `cpu-dynamic-audio-normalize` | 1487.75 | 1321.286 | 0.888110 | 1.751361 |
| `cpu-dynamic-audio-parse` | 167.162 | 177.33 | 1.060827 | 1.780996 |
| `cpu-hifido-normalize` | 2864 | 2415.778 | 0.843498 | 1.751380 |
| `cpu-hifido-parse` | 365.69 | 397.222 | 1.086226 | 1.787850 |
| `cpu-rewire-discover` | 18.758 | 21.115 | 1.125653 | 1.950562 |
| `cpu-rewire-normalize` | 5834.2 | 6034 | 1.034246 | 1.751176 |
| `cpu-rewire-parse` | 558.632 | 511.544 | 0.915708 | 1.757222 |

## Ownership registration review

- Existing owner: `queue-redelivery`. Add the two export-job repositories and `data-export-job-lifecycle.ts` as sources; require their four existing export/recovery suites.
- Policy digest before: `9effc356a88d667d9147f716c9cc11004a618804bdc8d83c26a45be7cf61b6a6`.
- Policy digest after: `5c0f167bf3c7caa2ac4300c07e79ad0099fbed6f23f7a359aebf790fe37312dc`.
- Self-review covered all implementation paths and the ownership change: scoped creation/selection and nullable legacy audit expiry remain in the original repositories; shared methods use only fixed table identifiers and bound values. No unresolved finding.
