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

## Ownership

Reuse package scripts, Vitest, Playwright, real migrated local D1 fixtures and deployment-owned
identity artifacts. Add a diagnostic at the boundary that owns the behavior. Keep orchestration
thin, execute bounded commands and leave concise machine-readable results for the next session.
