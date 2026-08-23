# GitHub Actions responsibility map

HiFiScout keeps workflow orchestration thin. Domain behavior, repair logic, and data-quality rules belong in application or maintenance scripts; workflows select when to run them and report the result.

## Validation

- `ci.yml` — release-quality source checks, D1 integration checks, build, and non-gating Playwright browser cache warming.
- `docs.yml` — architecture boundary check plus documentation build/publish.
- `codeql.yml` — CodeQL security analysis.
- `secret-scan.yml` — secret scanning.
- `autofix.yml` — PR formatting/lint autofix only.

## Production deployment

- `deploy.yml` — provision required Cloudflare resources, apply backward-compatible migrations, deploy the public Worker, and perform a small runtime smoke check.
- `deploy-catalog-admin.yml` — deploy the Cloudflare Access-protected admin Worker from the exact public-Worker deployment SHA.
- `deploy-audiounion-lambda.yml` — deploy the AudioUnion relay Lambda.
- `sync-audiounion-relay-secret.yml` — synchronize the relay credential required by the public Worker.

`Deploy Cloudflare` publishes a one-day `deployment-identity` artifact. Every automatic downstream workflow must consume that artifact and operate on the exact deployed SHA; `workflow_run.head_sha` is not a deployment identity.

## Post-deploy verification

- `e2e.yml` — browser/user-flow regression only. It does not monitor asynchronous queues or protected admin APIs.
- `production-operational-health.yml` — production data-platform, Product Search identity, and Knowledge Catalog operational checks. Failures report degraded operations but do not rewrite a successful deployment.

Operational-health workflows are detection/reporting paths. They must not automatically mutate production data or re-run themselves through repair loops. Repair commands may exist as explicit maintenance scripts and can be invoked deliberately when an operator has identified the incident.

## Manual data operations and audits

- `product-data-audit.yml` — full production representation export for manual audit.
- `apply-approved-category-audit.yml` — apply an explicitly approved category audit.
- `apply-manual-category-authority.yml` — apply explicit manual category authority.
- `resolver-replay-drain.yml` — bounded resolver replay maintenance.

These workflows are intentionally separate from deployment and post-deploy verification because they can mutate or exhaustively inspect production data.

## Repository operations

- `backup.yml` — production backup.
- `release.yml` — semantic release.

## Rules for new workflows

1. Prefer extending an existing responsibility owner over adding another Deploy fan-out.
2. Keep deploy success limited to deployment/migration/smoke-test failures; broad data-state incidents belong to operational health.
3. Keep E2E focused on observable user behavior. API/data invariants belong in unit, contract, integration, or operational checks.
4. Do not encode autonomous production repair loops in Actions YAML.
5. Reuse `.github/actions/publish-commit-status` for custom commit statuses.
6. Use the root `package-lock.json`; do not create an unlocked secondary Node dependency installation for E2E.
