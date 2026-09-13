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

## Checkpoint and resume

Start from `task.example.json`, replacing the goal and requirements with the actual request.
`vp run harness checkpoint <task.json> <report.json> <state.json> 0` creates a checkpoint.
For an update, pass the revision reported by the last successful write instead of 0. The command
stores incomplete reports too; exit 2 means evidence remains incomplete, not that saving failed.
`vp run harness resume <state.json>` compares recorded evidence with the actual Git checkout and
prints constraints, remaining check IDs and next actions. It never executes text from the task.

The task specification owns required check IDs and scopes. A runner cannot waive a requirement
by omitting it, setting required=false, or relabeling its scope. Scope changes require a new
checkpoint. Revision checks and an exclusive writer lock prevent concurrent overwrites; a failed
write preserves the prior state. A lock left by a terminated process requires deliberate cleanup
after confirming that no writer remains.

Preserve checkpoints in Git or as task/CI artifacts before ending a session. They record the last
tested SHA; committing a checkpoint or changing source does not transfer previous test success to
the new SHA. A dirty or changed checkout requires fresh evidence. Use the existing AGENTS.md task
map to find current sources; old checkpoint prose does not override current code or authorization.

## Product regression replay

`vp run harness replay .generated/product-replay` runs the fixed existing suites listed in
`scripts/harness/replay.ts`. It preserves the raw Vitest result, runner log, individual assertion
failures and a common report for extraction, normalization, classification, identity, search and
admin override stages. These are local fixture outcomes, not a measured production accuracy rate.
The normal CI shards already execute these cases; the required `product-replay` job imports their
four JSON artifacts instead of running the tests again. Failed shards preserve their reports too.
Missing suites and skipped/pending assertions remain unknown. No seller requests are required.

Run the command on clean baseline and candidate checkouts, preserve both directories, then use
`vp run harness compare-replay <baseline/replay.json> <candidate/replay.json>` to list regressions
and improvements by case/stage. The corpus digest includes the suite selection, selected test
sources, tracked fixtures and shared test helpers. A changed corpus, changed case membership,
missing result or dirty checkout makes comparison unknown. An unchanged known failure is visible
in the candidate report even when the comparison has no new regressions. Imported Vitest reports
must come from that checkout's CI graph; the import mode does not authenticate arbitrary JSON.

## Cost evidence and comparison

The existing parser benchmark and selected budget tests write source-bound samples when
`HARNESS_COST_OUTPUT` is set. CI collects 13 required samples without re-running those tests:
split/inline D1 checkpoints, indexed category pruning (including EXPLAIN details), a DO retry,
Queue redelivery, and eight parser stages. Measurement-producing task cache keys include
`GITHUB_SHA`, so a previous commit's samples cannot be restored as this commit's observations.

For a local capture on a clean checkout:

```bash
HARNESS_COST_OUTPUT=.generated/cost vp test run test/d1-crawl-checkpoint-budget.test.ts test/observed-sql-read-budget.test.ts test/crawl-do-collection-progress.test.ts test/queue-routing.test.ts
HARNESS_COST_OUTPUT=.generated/cost vp run benchmark:parser
vp run harness cost-report .generated/cost .generated/cost-report.json
vp run harness compare-cost <baseline-samples-dir> <candidate-samples-dir>
```

Use fresh directories and retain failed test/benchmark output as well as samples. A sample's
existence proves measurement, not behavioral success; CI's original assertions and CPU baseline
gate remain required. Missing samples, dirty/stale SHAs and missing D1 meta stay unknown. The D1
meter counts batches once, counts failures, and marks row totals null after unmetered first/raw
calls. Local workerd rows, mocked DO/Queue calls and Node CPU have distinct environments and units.
They never stand in for production billing or p95/p99 CPU. Production CPU remains explicitly null.

Comparisons require the same fixture/helper/dependency profile and environment. They show absolute
deltas, and ratios only for nonzero baselines. Row/statement/message increases fail; relative CPU
uses the parser gate's 75% plus 0.5 noise margin. Absolute local CPU is diagnostic only. Changing
fixtures or runtime dependencies requires a new reviewed baseline, not a manufactured improvement.

## Architecture gate

`vp run check:architecture` runs the existing pinned dependency-cruiser rules in
`.dependency-cruiser.json`. It is part of normal `check`/`verify` and the required CI static job;
the documentation command delegates to the same entrypoint. CI's explicit cache inputs include
the rule file, TypeScript configuration, dependency lock and both source trees.

The long diagnostic names the violated rule, source and target modules, and the rule's reason.
Use that owning boundary to repair the dependency: browser imports belong in API contracts;
domain decisions stay independent of repositories; shop adapters enter through the registry;
crawl scheduling and Knowledge Catalog verification retain their own orchestration. Move shared
types or inject the necessary capability at the composition root, then rerun the same command.
Rule exceptions and baseline suppression files require an explicit architectural change; do not
add one merely to make CI pass. There is no second hand-written dependency checker.

## Extension points

## Isolated UI evidence

`vp run harness ui .generated/ui-<run-id>` builds the admin bundle and runs the existing gallery
and authenticated admin suites. The output directory must be new. Install the same Playwright
browser used by CI first. The gallery owns its loopback server and each admin test owns an
ephemeral loopback port, RSA key and in-memory RPC state. The real admin entry still verifies
Access, CSRF and request contracts. This command has no production target or credentials.

Harness mode disables gallery server/context reuse and blocks browser HTTP/WebSocket requests
outside the fixture origin. Existing signed local Access and RPC/JWKS mocks retain their strict
unexpected-call checks. Each case preserves a screenshot, HTML, console/page errors, request
metadata without headers/bodies/query strings, SHA, URL and retry number. Admin server errors
are attached too; Playwright retains failure traces. Normal CI enables this mode and uploads
the existing `component-ui-review` artifact, including final JSON results for both suites.

Per-case evidence records the test status at capture time. Final Playwright results, including
fixture teardown, own completion; the CLI uses those results and its process exits for the common
report. Missing/skipped results or a dirty/changed checkout stay unknown. These are browser tests
against local data, not deployment or production verification. Review screenshots/DOM together
with console and network evidence; an image alone does not prove an interaction succeeded.

## Adding a boundary

Reuse package scripts, Vitest, Playwright, real migrated local D1 fixtures and deployment-owned
identity artifacts. Add a diagnostic at the boundary that owns the behavior. Keep orchestration
thin, execute bounded commands and leave concise machine-readable results for the next session.
