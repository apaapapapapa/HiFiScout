# Database Schema

The database reference is generated from the same D1 migrations used by the application.

<a href="../db/index.html" target="_self">Open the generated SchemaSpy database documentation</a>

## How it is generated

1. Wrangler applies every migration to an isolated local D1 state directory created only for documentation generation.
2. HiFiScout identifies the migrated application database by its required tables and checkpoints committed WAL pages into the SQLite database file.
3. SchemaSpy analyzes a disposable copy through the Xerial SQLite JDBC driver and generates tables, columns, indexes, relationships, and diagrams.
4. VitePress copies the generated SchemaSpy site into the developer documentation artifact.

This keeps `migrations/*.sql` as the schema source of truth. No production D1 credentials, production data, or pre-existing local D1 state are required for documentation generation.

## Migration changes and deployment

Wrangler remains the migration runner. Files already on `main` are immutable: do not edit,
delete, rename, or renumber them, even to fix a comment. Correct mistakes with the next numbered
forward migration. New files must have unique, consecutive four-digit prefixes after the highest
baseline prefix; the two historical duplicate prefixes remain frozen as-is.

`check:migrations` compares filenames and SQL bytes against a real Git commit and fails closed
if that commit is unavailable. The required `migration-safety` CI job uses the PR's base SHA or
the previous main push SHA, including on changes that add no SQL. Deployment repeats the same guard and seeded upgrade against
the last successfully deployed SHA before touching Cloudflare resources. Its baseline comes from
the deployment identity artifact, so a quota-deferred deployment cannot become the baseline.
The first deployment has no production baseline and relies on CI's Git baseline.

```sh
# Fetch the baseline first; a shallow checkout must contain the referenced commit.
git fetch origin main
MIGRATION_BASE_REF=origin/main vp run test:migrations
```

The test creates disposable local workerd D1 databases and extracts the actual previous `src/`
and `frontend/` from that SHA. It writes a fixture using the previous crawler and checks:

- Price history, listing identity, and persistent admin overrides survive the upgrade.
- The previous runtime still reads the DB after each new migration, including an interrupted
  multi-file deployment; the new runtime works before, during, and after a bounded backfill.
- Old and new metadata/search responses pass the opposite version's browser guards, covering a
  cached frontend during rollout or a Worker rollback. Both versions can replay crawler writes.
- Fresh installation and seeded upgrade produce the same schema, and foreign keys remain valid.
- A failed migration rolls back its DDL, data, and history entry together; earlier successful
  files remain committed and the failed file can be retried.

These are selected application contracts, not an exhaustive production snapshot or browser E2E.
Extend the fixture/probes when changing another critical data path. A destructive schema change
must be staged: add a compatible representation, deploy code that tolerates both states, backfill,
verify completion, stop old reads/writes, then remove the old representation in a later release
after the rollback window closes. Do not relax the previous-runtime test to make a drop pass.
Worker rollback does not undo database migrations; schema recovery uses a forward fix or an
explicitly planned restore.

## Bulk data work

Keep historical scans, ranking, and large updates out of deploy-time SQL. Schema migrations create
tables, compatible columns, and constant-size job state; runtime work performs data conversion.
Index creation on an existing large table can still scan/write many rows and needs its own cost
assessment. The recent-price projection uses migration `0078` for its initial cursor and `0088`
for admission/pacing fields; neither new field backfills historical samples.

`backfillRecentPriceIndexes` is the maintained example:

- A keyset cursor selects at most 25 products plus one lookahead. Indexed sample preflight reads
  at most 501 recent asking samples per candidate, including null prices conservatively.
- A page admits at most 500 samples for any one product and 1,000 across all admitted products.
  The counts are checked again inside the write transaction. A concurrent crawler that exceeds
  the admitted counts causes a retry instead of an unexpectedly large median calculation.
- A unique page token, the projection writes, and the cursor update share one D1 batch. A stale
  contender writes no projections or progress. Any failed statement rolls back the whole page;
  retries resume from the last committed cursor.
- `next_batch_after` persists a one-hour minimum interval across invocations. The normal scheduled
  path processes at most 600 products per 24 hours. This is a work cap, not an account-wide D1 quota.
  Test/operator code may explicitly select a shorter interval for a controlled run.
- The existing invocation budget admits the atomic batch before writing. A full 25-product page
  uses three D1 binding calls and 54 SQL statements; a batch does not make its statements or index
  writes free. The wall deadline limits starting further work, not the CPU time of a running query.

Watch `price_index_recent_refresh` for `backfillHasMore`, `backfillDeferredReason`, and
`backfillBlockedCatalogProductId`. `cooldown` means wait for the next hourly run; `conflict` means
another page or a crawler won admission and the next run can retry. `sample_budget` identifies a
product too large for the current bound: the cursor deliberately stops before it. Inspect that
product and its query costs, then review a larger bounded configuration or a separate resumable
algorithm. Do not skip its ID, delete history, or run an unrestricted aggregate to clear the alert.

Use the companion `scheduled_maintenance_d1_usage` event for actual `rowsRead`, `rowsWritten`,
and statement counts, together with `general_cron_d1_usage` for invocation limits. The
workerd regression fixture exercises 500 samples per product, caps a 1,000-sample page at 20,000
reported reads and 40 writes, and verifies zero cooldown writes. Those thresholds are regression
budgets for that fixture, not a prediction of total production usage. The same scheduled task's
expiry refresh has its own 25-product bound and is included in the task's usage log.

## Command

Docker is required for SchemaSpy generation.

```sh
vp run docs:db
```
