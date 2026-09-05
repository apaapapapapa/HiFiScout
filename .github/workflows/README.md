# GitHub Actions responsibility map

HiFiScout keeps workflow orchestration thin. Domain behavior, repair logic, and data-quality rules belong in application or maintenance scripts; workflows select when to run them and report the result. Current workflow files define the active inventory; add another workflow only for a responsibility that cannot fit an existing owner.

## Validation

- `ci.yml` — source/toolchain checks, sharded Vitest, parser performance, local D1 integration, React browser component tests, builds, and dependency security. Short checks share the `static-checks` runner. The component job also populates the shared Chromium and pinned Noto CJK caches; unit jobs need no browser.
- `docs.yml` — architecture boundary check plus deterministic documentation build/publish. Its separate best-effort AI refresh job may update only `docs/ai-generated/**`, validates candidates with Archify and a full VitePress build, and opens/updates a documentation PR. Missing credentials, Codex usage limits, timeouts, invalid output, or publication restrictions retain the last committed snapshot and do not block deterministic docs publication.
- `codeql.yml` — CodeQL security analysis.
- `secret-scan.yml` — secret scanning.
- `autofix.yml` — PR formatting/lint autofix only.

`.github/actions/change-scope` compares the candidate tree with the event's comparison base. Documentation-only changes retain source/toolchain checks and the always-present `fan-out` result but skip application test/build/security steps. Unknown bases run the full suite. All application jobs still report a result, so a workflow-level path filter cannot strand the required check in Pending. The dependency audit still runs for every application change; CodeQL and the weekly secret scan retain their own schedules.

The Docs workflow caches generated SchemaSpy output by the migration contents, Wrangler/dependency configuration and generator sources. The generator verifies the fingerprint and its output before reuse; cache misses run the original fresh local migration and SchemaSpy generation. This cache never supplies databases to migration safety tests.

## Production deployment

- `deploy.yml` — provision required Cloudflare resources, apply backward-compatible migrations, deploy the public Worker, and perform a small runtime smoke check.
- `deploy-catalog-admin.yml` — deploy the Cloudflare Access-protected admin Worker from the exact public-Worker deployment SHA.
- `deploy-audiounion-lambda.yml` — deploy the AudioUnion relay Lambda.
- `sync-audiounion-relay-secret.yml` — synchronize the relay credential required by the public Worker.

`Deploy Cloudflare` publishes a 90-day `deployment-identity` artifact only after the public Worker and deployment-owned smoke checks succeed. The SHA inside that artifact (`deployment-sha.txt`) is the authoritative production baseline; the Deploy workflow run's `head_sha` and a downstream `workflow_run.head_sha` are not deployment identities. Every automatic downstream workflow must consume that artifact and operate on the exact deployed SHA.

Cloudflare D1 free-tier daily row-read or row-write exhaustion (`7500`) is an external capacity gate, not evidence that the candidate Worker is invalid. If either quota blocks required migrations, `Deploy Cloudflare` succeeds as **deferred**, does not publish `deployment-identity`, leaves production on the last confirmed deployed SHA, and retries after the midnight-UTC quota reset. The scheduled retry never uses the schedule event's default-branch SHA: it resolves the newest successful `CI` run on `main` and proceeds only when that SHA's latest `deployment/cloudflare` status is the D1-quota-deferred status. A scheduled run with no such target is an intentional no-op.

For migration comparison, `Deploy Cloudflare` reads the newest valid, unexpired `deployment-identity` artifact and extracts `deployment-sha.txt` directly rather than inferring production from workflow metadata. Keeping confirmed identities for 90 days makes that baseline available across long periods without deployment, while the CI/status gate prevents nightly no-op runs from redeploying an unapproved or already-settled SHA. Downstream E2E, operational-health, and Catalog Admin workflows treat a missing `deployment-identity` from an otherwise successful `Deploy Cloudflare` run as “no new public deployment” and exit successfully without operating on `workflow_run.head_sha`.

Application change detection uses that same confirmed production baseline, not the preceding main commit. Documentation-only differences produce an `application unchanged` status and no new identity artifact; pending code or migrations from an earlier deferred deployment still deploy. CI migration safety compares the PR/push base, while CD verifies upgrade from the actual deployed runtime, so both checks remain necessary.

Production resources are reconciled by `scripts/lib/production-resources.ts`: an unchanged bucket, lifecycle policy and required Queue set use three reads and no writes. Only a genuine missing resource is created. Owned lifecycle rules update together while unrelated operator policies remain intact; authentication errors and malformed responses fail instead of being interpreted as missing configuration.

## Post-deploy verification

- `e2e.yml` — browser/user-flow regression only. It does not monitor asynchronous queues or protected admin APIs.
- `production-operational-health.yml` — production data-platform, Product Search identity, and Knowledge Catalog operational checks. Failures report degraded operations but do not rewrite a successful deployment.

Operational-health workflows are detection/reporting paths. They must not automatically mutate production data or re-run themselves through repair loops. Repair commands may exist as explicit maintenance scripts and can be invoked deliberately when an operator has identified the incident.

The active-crawl wait keeps its existing bound. After that, the first projection drift observation creates one cron-plus-grace deadline in `PROJECTION_CONVERGENCE_STATE_FILE`; identity coverage, stale fallback and split-group checks share it. Each check still re-reads and fails on persistent drift, but cannot grant another full cron window after an earlier check already waited.

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
