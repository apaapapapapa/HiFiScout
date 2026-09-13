# Development harness

The harness connects existing verification tools with explicit acceptance evidence. It runs in the
development/CI environment; it does not add a production Worker, D1 table or autonomous repair job.

## Evidence reports

Run `vp run harness report .generated/harness/report.json` to validate and assess a report.
The schema and status calculation are owned by `scripts/harness/report.ts`.

- Every report names a full source SHA, explicit nullable baseline/deployment SHAs, an execution
  interval and nonempty uniquely named checks. Each check has a required flag, source/deployment/
  observation scope, status, reason and evidence references with their own source SHA.
- `pass`, `fail`, `unknown` and `skipped` remain distinct. Required skips, missing evidence,
  stale-SHA evidence and unconfirmed deployment identity prevent completion. An optional skipped
  production audit does not invalidate a completed source-only task.
- A source check proves only that source. Deployment/observation checks also require a confirmed
  matching deployment identity. CI success, main merge, deployment and production effectiveness
  are separate acceptance conditions.
- Exit codes are 0 for all required checks passing, 1 for a required failure and 2 for incomplete
  evidence or invalid input. The JSON output is the assessed report; errors go to stderr.
- References are HTTPS URLs or repository-relative artifacts. The assessor validates structure
  and identity, not the truth of arbitrary caller-authored assertions. Prefer reports produced by
  the executable collectors/runners; preserve their underlying artifacts for review.

Unknown measurements must remain null with an explanation. Quota-deferred deployment does not
create a deployment identity. Intentionally paused operational audits remain paused. A report must
not enable them, query production to fill a gap or turn a gap into zero.

## GitHub delivery evidence

`vp run harness delivery apaapapapapa/HiFiScout <PR> .generated/harness/delivery` collects
read-only GitHub evidence through authenticated `gh` (available on GitHub-hosted runners).
It writes `github-snapshot.json` and `delivery-report.json` and uses the report exit codes above.
Authentication needs repository contents, Actions and pull-request reads. No token is printed.

The collector checks main merge, latest CI for the exact source, all inline review-thread pages,
the deployment status's own run and its downloaded `deployment-identity` contents, admin deployment
and public E2E statuses. It reads the PR again to detect concurrent head/merge changes. Workflow
event SHAs are never substituted for deployment identity. Pending, expired, absent and deferred
evidence stays incomplete. It neither merges PRs nor changes configuration or production data.

This is a delivery snapshot, not proof of current production traffic allocation or a 72-hour
baseline. Top-level conversational comments still need agent/human review; only inline resolution
and GitHub's review decision can be evaluated mechanically. Optional paused audits stay skipped.
API/authentication/transport failure exits 2; it cannot yield a passing partial snapshot.

Automatic E2E and admin workflows publish `post-deploy-receipt` only after their verification
succeeds. It binds the checked-out SHA, parent deployment run, verification run/attempt and actual
production target. The collector downloads the latest status's receipt and checks those fields
against GitHub metadata. Manual E2E (including alternate URLs), receipts from an earlier attempt
and unrelated parent deployments cannot establish production verification. Automatic E2E uses
the configured production URL; manual E2E retains its alternate-URL input. Earlier runs without
receipts remain unconfirmed rather than receiving retroactive evidence.

## Ownership

Reuse package scripts, Vitest, Playwright, real migrated local D1 fixtures and deployment-owned
identity artifacts. Add a diagnostic at the boundary that owns the behavior. Keep orchestration
thin, execute bounded commands and leave concise machine-readable results for the next session.
