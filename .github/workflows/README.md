# GitHub Actions responsibility map

`production-operational-health.yml` also owns a passive `d1-sql-archive` job. Its 15-minute schedule
only archives native D1 Insights to private R2; it never runs the D1-backed convergence/repair jobs.
The archive runs even after failed deployments and resolves the active Worker binding independently
of `deployment-identity`. See [D1 SQL observation](../../docs/d1-sql-observation.md) for retention,
coverage limits, permissions and incident analysis.
The same workflow produces a public-safe `d1-sql-load-report` artifact and a machine-readable job-log
line from saved gzip objects before the four daily assistant checks. Its extra report schedule reads
R2 only, uses a separate concurrency group, and leaves the normal 15-minute collection unchanged.
SQL text and raw archives never enter the public report; use the dedicated `report-d1-sql.ts` entrypoint.

HiFiScout keeps workflow orchestration thin. Domain behavior, repair logic, and data-quality rules belong in application or maintenance scripts; workflows select when to run them and report the result. Current workflow files define the active inventory; add another workflow only for a responsibility that cannot fit an existing owner.

## Validation

- `ci.yml` — source/toolchain checks, sharded Vitest, parser performance, local D1 integration, React browser component tests, authenticated admin browser tests with local Access/RPC mocks, builds, and dependency security. Short checks share the `static-checks` runner. The component job runs both browser suites and populates the shared Chromium and pinned Noto CJK caches; unit jobs need no browser.
- `docs.yml` — architecture boundary check plus deterministic documentation build/publish. Its separate best-effort AI refresh job may update only `docs/ai-generated/**`, validates candidates with Archify and a full VitePress build, and opens/updates a documentation PR. Missing credentials, Codex usage limits, timeouts, invalid output, or publication restrictions retain the last committed snapshot and do not block deterministic docs publication.
- `codeql.yml` — CodeQL security analysis.
- `secret-scan.yml` — secret scanning.
- `autofix.yml` — PR formatting/lint autofix only.

`.github/actions/change-scope` compares the candidate tree with the event's comparison base. Documentation-only changes retain source/toolchain checks and the always-present `fan-out` result but skip application test/build/security steps. Unknown bases run the full suite. All application jobs still report a result, so a workflow-level path filter cannot strand the required check in Pending. The dependency audit still runs for every application change; CodeQL and the weekly secret scan retain their own schedules.

The Docs workflow caches generated SchemaSpy output by the migration contents, Wrangler/dependency configuration and generator sources. The generator verifies the fingerprint and its output before reuse; cache misses run the original fresh local migration and SchemaSpy generation. This cache never supplies databases to migration safety tests.

## Production deployment

- `deploy.yml` — provision required Cloudflare resources, apply backward-compatible migrations, deploy the public Worker, and perform a small runtime smoke check.

`verify-maintenance-access-paths.ts` resolves the active Worker's D1 binding and checks the stalled-run
and scoped-deletion plans in the deployment-owned runtime smoke check. It logs plans and read/write counts, not row data.
Only an unambiguous D1 `7500` daily row quota error defers confirmation through the existing quota-reset retry; unknown failures remain fatal.
The DELETE is only explained, never executed; the only application-row probe is the indexed
running-work selector with LIMIT 5. This does not resume the paused operational health audits.
- `deploy-catalog-admin.yml` — deploy the Cloudflare Access-protected admin Worker from the exact public-Worker deployment SHA.
- `deploy-audiounion-lambda.yml` — deploy the AudioUnion relay Lambda.
- `sync-audiounion-relay-secret.yml` — synchronize the relay credential required by the public Worker.

Remote migrations use `db:migrate:remote`: each pending SQL file and its `d1_migrations` record
are applied together through Wrangler's atomic SQL import path. This avoids the remote query
endpoint's compound-trigger parsing failure without changing frozen SQL. Retries consult actual
D1 history and resume at the first unapplied file; quota/CPU diagnostics retain their existing handling.

`Deploy Cloudflare` publishes a 90-day `deployment-identity` artifact only after the public Worker and deployment-owned smoke checks succeed. The SHA inside that artifact (`deployment-sha.txt`) is the authoritative production baseline; the Deploy workflow run's `head_sha` and a downstream `workflow_run.head_sha` are not deployment identities. Every automatic downstream workflow must consume that artifact and operate on the exact deployed SHA.

Cloudflare D1 free-tier daily row-read or row-write exhaustion (`7500`) is an external capacity gate, not evidence that the candidate Worker is invalid. If either quota blocks required migrations, `Deploy Cloudflare` succeeds as **deferred**, does not publish `deployment-identity`, leaves production on the last confirmed deployed SHA, and retries after the midnight-UTC quota reset. The scheduled retry never uses the schedule event's default-branch SHA: it resolves the newest successful `CI` run on `main` and proceeds only when that SHA's latest `deployment/cloudflare` status is the D1-quota-deferred status. A scheduled run with no such target is an intentional no-op.

For migration comparison, `Deploy Cloudflare` reads the newest valid, unexpired `deployment-identity` artifact and extracts `deployment-sha.txt` directly rather than inferring production from workflow metadata. Keeping confirmed identities for 90 days makes that baseline available across long periods without deployment, while the CI/status gate prevents nightly no-op runs from redeploying an unapproved or already-settled SHA. Downstream E2E, operational-health, and Catalog Admin workflows treat a missing `deployment-identity` from an otherwise successful `Deploy Cloudflare` run as “no new public deployment” and exit successfully without operating on `workflow_run.head_sha`.

Application change detection uses that same confirmed production baseline, not the preceding main commit. Documentation-only differences produce an `application unchanged` status and no new identity artifact; pending code or migrations from an earlier deferred deployment still deploy. CI migration safety compares the PR/push base, while CD verifies upgrade from the actual deployed runtime, so both checks remain necessary.

Production resources are reconciled by `scripts/lib/production-resources.ts`: an unchanged bucket, lifecycle policy and required Queue set use three reads and no writes. Only a genuine missing resource is created. Owned lifecycle rules update together while unrelated operator policies remain intact; authentication errors and malformed responses fail instead of being interpreted as missing configuration.

## Post-deploy verification

Production operational health checks are temporarily paused at the operator's request.
The `data-platform` and `knowledge-catalog` jobs have unconditional false job guards, so neither
post-deploy nor manual workflow runs execute their queries or publish health statuses.
New post-deploy/manual runs cancel older runs in the checks concurrency group, including any
health checks that started before the pause. Scheduled passive archives retain their separate group.
The passive `d1-sql-archive` job continues collecting native Insights into R2 without querying D1.
To resume health checks after explicit approval, restore both job conditions to
`github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'`.

- `e2e.yml` — browser/user-flow regression only. It does not monitor asynchronous queues or protected admin APIs.
- `production-operational-health.yml` — passive D1 SQL archive remains active; production data-platform, Product Search identity, and Knowledge Catalog operational checks are paused. When enabled, failures report degraded operations but do not rewrite a successful deployment.

Operational-health workflows are detection/reporting paths. They must not automatically mutate production data or re-run themselves through repair loops. Repair commands may exist as explicit maintenance scripts and can be invoked deliberately when an operator has identified the incident.

The active-crawl wait keeps its existing bound. After that, the first projection drift observation creates one cron-plus-grace deadline in `PROJECTION_CONVERGENCE_STATE_FILE`; identity coverage, stale fallback and split-group checks share it. Each check still re-reads and fails on persistent drift, but cannot grant another full cron window after an earlier check already waited.

When explicitly run, the data-platform script makes one full search-entity observation and captures
the affected entity/listing IDs. Its remaining observations query only that scope and the listings'
current memberships, retaining the initial catalog-wide counts as snapshot metadata. A deleted
fallback is still checked for a missing listing membership. More than 1,000 IDs in either scope fails
immediately instead of retrying a truncated sample or repeating the full audit. These rechecks prove
convergence of the captured scope; unrelated changes after the first observation await a later audit.
Latest quality history starts from indexed distinct-shop seeks and then fetches one indexed row per
shop, including retired shops; equal timestamps select the highest ID. It does not scan every
historical quality row. These SQL changes do not enable the suspended operational-health jobs.

### D1 query accounting

The data-platform, Product Search identity and active-crawl convergence scripts share
`scripts/lib/d1-health-query.sh`. Every existing query, including FTS integrity checking, has a
stable diagnostic label. The helper emits `operational_health_d1_query` JSON to stderr with the
label, retry attempt, statement index, outcome, `rowsRead`, `rowsWritten` and `durationMs` from
D1's response. Result rows remain alone on stdout for the existing shell callers. The metrics
add no database calls or D1 counter writes and remain in GitHub Actions logs when D1 is unavailable.

Count each emitted statement/attempt once. Missing or malformed metadata is `null` with
`metadataPresent: false`, not an invented zero; incomplete telemetry cannot establish the total
account usage. Retries retain any metadata returned before an invalid result shape, while failed
queries continue to fail after their bounded attempts. These events do not include SQL, bind
values or result rows. They cover these operational scripts, not all application traffic.

`test/d1-health-query.test.ts` uses a local CLI stub to check stdout isolation, call count,
per-statement metadata, zero/unknown values, retries and terminal failures without production access.
`test/exact-identity-peer-budget.test.ts` separately runs local Miniflare D1 at 100/1,000/10,000
listings, holding one identity fixed while unrelated makers/models/categories grow. It checks
correlated lookup cost, cross-shop repair, unchanged replay writes and conservative eligibility.
Local fixture measurements are regression gates, not production account-wide savings estimates.

## Manual data operations and audits

- `product-data-audit.yml` — full production representation export for manual audit.
- `apply-approved-category-audit.yml` — apply an explicitly approved category audit.
- `apply-manual-category-authority.yml` — apply explicit manual category authority.
- `resolver-replay-drain.yml` — bounded resolver replay maintenance.

These workflows are intentionally separate from deployment and post-deploy verification because they can mutate or exhaustively inspect production data.

Manual category authority requires a confirmed `deployment-identity` before resolving D1 or running
either mutation script. A source-triggered run verifies that the artifact SHA equals its requested
commit; a quota-deferred or no-op Deploy without an artifact defers the maintenance without touching
D1. Once production is confirmed, explicitly dispatch the maintenance workflow if the operation is
still required. A manual dispatch checks out the latest confirmed production SHA from its artifact,
so selecting a workflow ref cannot apply undeployed category logic to production. This remains an
explicit maintenance operation, with no automatic repair or replay loop.

## Repository operations

- `backup.yml` — production backup.
- `release.yml` — semantic release.

## Rules for new workflows

1. Prefer extending an existing responsibility owner over adding another Deploy fan-out.
2. Keep deploy success limited to deployment/migration/smoke-test failures; broad data-state incidents belong to operational health. Explicitly recognized account-wide quota exhaustion may defer a deployment only when the workflow preserves the previous deployment identity and schedules a bounded retry.
3. Keep E2E focused on observable user behavior. API/data invariants belong in unit, contract, integration, or operational checks.
4. Do not encode autonomous production repair loops in Actions YAML.
5. Reuse `.github/actions/publish-commit-status` for custom commit statuses.
6. Use the root `package-lock.json`; do not create an unlocked secondary Node dependency installation for E2E.
7. Keep optional AI generation outside deterministic validation/deployment ownership. AI failures must degrade to the last committed artifact rather than fail the documentation site.
