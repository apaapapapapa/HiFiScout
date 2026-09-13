# Development harness

The harness connects existing verification tools with explicit acceptance evidence. It runs in the
development/CI environment and does not add a production Worker or D1 table.

## Isolated loop execution

Run the loop CLI from the trusted controller checkout. `loop prepare <state> <source-repo>
<workspace-root>` creates one owned `automation/loop/<task-id>` Git worktree at the frozen baseline;
it refuses a foreign origin, unowned directory, changed branch or dirty checkout. Keep the state and
workspace root outside the repair checkout and retain them together across sessions.

Before requesting a repair, `loop begin <state> <attempt.json>` charges the iteration and reservations.
The request contains `hypothesis`, `externalCalls` and `reservedCostMicros`. The native coding agent
returns a unified text patch; `loop apply <state> <workspace-root> <iteration> <base-sha> <patch>`
stages it in a temporary Git index, checks the complete baseline diff, and commits only permitted
changes. Each attempt accepts one patch. The original checkout is untouched. Retries of the same
patch are idempotent; an interrupted recorded transaction can be retried with the same arguments.
Locks are never stolen. `loop block/resume/stop <state> <reason>` records operator decisions without
resetting spent attempts, reservations or deadlines. Worktrees isolate edits; they are not an OS sandbox.

## Loop evaluation

`loop evaluate <state> <workspace-root> [AI-recording.json]` executes the pinned locked dependency
setup and read-only `vp run check` in the owned worktree, then records the actual clean commit and
Git scope. Commands use a fixed argument list, sanitized environment, bounded logs and a process-group
deadline. A fresh artifact directory is required per attempt; interrupted attempts must be blocked
and resumed deliberately, retaining their charges. Keep the workspace/journal and generated evidence.

Product and cost contracts measure their frozen baseline in a separate detached worktree and retain
it for later attempts. Existing replay and cost collectors compare identical corpora/profiles; missing
coverage or mismatched SHAs stay unknown. Frontend repairs and explicit UI requirements also invoke
the existing local browser harness. AI contracts require a candidate-bound recorded response file;
the offline holdout runner does not make provider calls or authorize activation. A source pass moves
to review, while production effectiveness requires separately collected operational evidence.

## Review and completion state

A verified candidate records `review-requested` once with its full SHA and PR number. The deadline
cannot be extended by repeated requests or heartbeats. Optional Codex review can fall back to a
recorded self-review after at most 15 minutes; a `self` contract can review immediately. Required
external approval cannot fall back, and still needs GitHub's explicit approval after a Codex review.
Each review receipt covers every changed path, retains its summary/artifact and unresolved-finding
count, and is invalidated by another attempt. Retrying the same SHA/PR retains its earliest waiting
deadline across block/resume and reevaluation. A timeout alone is never a completed review.

The delivery transition reassesses the collected GitHub snapshot, matching the reviewed PR head.
PR completion needs its CI and review gates; merge completion additionally needs main CI on the
actual merge SHA. Deployment completion requires the owning deployment identity and downstream
receipts. Missing evidence stays pending; failed gates block. Repeated identical polls do not count
as progress, and even an otherwise passing final result cannot exceed the original run deadline.

## Loop PR lifecycle

With authenticated Git push and `gh`, `loop publish <state> <workspace-root>` pushes only the verified
commit to its owned branch and creates/reuses one PR. It records the review request once; PR opening
uses the repository's automatic Codex review, while an updated PR gets one explicit request.
`loop review <state> <workspace-root> [self-review.json]` polls without sleeping. Codex results must
resolve to the full candidate SHA and all review threads must be resolved. After the optional deadline,
the coding agent supplies a real self-review receipt (`sourceSha`, `method: self`, `completedAt`,
`summary`, `reviewedPaths`, `unresolvedFindings`, `artifactUri`); the CLI never fabricates that review.

`loop merge <state> <workspace-root>` requires a merge/deployment contract and current review/CI gates,
then uses GitHub's normal merge API with an expected-head guard. `loop observe <state> <workspace-root>`
retains fresh GitHub snapshots and advances only when the contracted target is verified. An in-progress
main run is pending, not success. These commands retain their journal and evidence on interruption;
rerunning publish does not create duplicate PRs or restart a recorded review wait. Updated PR review
requests retain a pending transport record and stable comment marker, so retries recover both failed
sends and lost acknowledgements without duplicating an accepted request. Retain those generated
records with the journal; an expired optional wait still moves to self-review without a new timer.

## Progress visibility

`loop status <state>` returns phase, reservations, remaining budgets, blockers, review deadline,
last recorded progress, last evaluation improvement and heartbeat separately. `--markdown` renders
the same snapshot as a table; `loop snapshot <state> <directory>` writes `status.json` and `status.md`
for artifacts or a GitHub step summary. `loop heartbeat <state>` records liveness reporting without
moving progress or deadlines. Status is evidence of the saved run, not a live process probe or an ETA;
completion time remains unknown and `nextCheckAt` is only a suggested observation time.

For an agent/CI handoff, retain the journal, owned worktrees/manifests and `.generated/loop` evidence
together, and append the generated Markdown to `$GITHUB_STEP_SUMMARY` in the owning runner. The CLI's
successful return means its operation was recorded: inspect `phase`, `reason` and `nextAction` to
continue or stop. A source failure that permits another attempt is not a completed repair.

## Retaining failures as regression knowledge

Add the regression test with the repair. `loop regression <state> <workspace-root> <proposal.json>`
copies only that newly added regular test into an isolated frozen-baseline worktree and runs the
same named assertion on baseline and candidate. The baseline must fail an actual assertion and the
candidate must pass; setup/import errors and already-passing baselines do not establish a regression.
The proof retains test/report digests, exact SHAs and runner evidence within the remaining time budget.

A proposal contains `id`, `title`, `testPath`, `assertionName`, HTTPS `sourceUrls`, nullable
`labelReviewNotes`, and a short `procedure` array. Product/AI cases require notes about label sources.
After the contracted delivery completes, `loop learn <state> <workspace-root> <proposal.json>
<knowledge-index.json>` verifies the saved proof and adds an idempotent case/procedure record.
Retain the bounded index with the run artifacts, or include reviewed records in a follow-up PR.
The committed regression test remains in the repair PR. Procedures are reference data, not authority.

All harvested cases are regression-only; they are never silently added to the fresh AI holdout.
Source-review notes do not claim independent human label review. Fresh holdout labels still need
separate source grounding and independent review before new model-selection measurements.

## Domain intake and native agent handoff

`vp run harness loop profiles` lists bounded defaults for CI, product identity, local cost and
offline AI repair. Generated contracts start with three attempts, two no-progress results, a one-hour
overall deadline, optional Codex review capped at 15 minutes and PR delivery. Review and narrow the
paths, budget and authorized delivery target before `init`; the contract is immutable afterwards.

`vp run harness loop intake-report <envelope.json> <directory>` imports an existing common report:

```json
{
  "schemaVersion": 1,
  "kind": "product",
  "repository": "apaapapapapa/HiFiScout",
  "evidenceUrl": "https://github.com/apaapapapapa/HiFiScout/actions/runs/123",
  "report": { "...": "existing complete HarnessReport" }
}
```

Use `source-checks` for CI, `replay/*` or `comparison:replay` for product,
`cost/*` or `comparison:cost` for cost, and `ai/offline-holdout` for AI. Only required failed source
checks with matching evidence SHAs produce proposals. Unsupported, unknown, skipped, unbound or
production-observation reports produce no repair task. This does not query production, restart
paused audits, call models, or prove the signal is still current. Check the current owning source
before accepting a task. Manual confirmed corrections can use the existing `ingest` signal schema
with retained primary-source evidence; they grant no authority to edit production rows.

The existing autofix workflow exports CI proposals as a 30-day artifact. Reuse a retained intake
directory/index across imports and sessions; downloading independent workflow artifacts alone does
not merge their indexes. Accepted contracts, journals, workspace manifests and raw evidence must
be retained for resumption. The native [hifiscout-loop skill](../../.agents/skills/hifiscout-loop/SKILL.md)
connects intake, hypothesis, patch, evaluation, review, merge and lesson retention. It uses the
current Codex session as the repair actor; no permanent Worker or unattended model runner is added.
`loop help` lists the complete CLI, including status, request recovery and lesson commands.

## Bounded improvement loops

`vp run harness loop validate .github/harness/loop.example.json` validates an execution contract.
Replace the example baseline with the full incident SHA before creating a run. The contract freezes
the goal, required harness checks, allowed change paths, comparison requirements, delivery/review
policy, iteration/time limits and external-call/cost reservations. Changing any of these requires a
new run. Cost reservations use integer microdollars; they are a spending allocation, not a claim of
measured provider billing. The default zero allocation permits only zero-cost adapters.

Repairs cannot modify the loop controller, harness gates, CI, agent authority, dependency/runtime
configuration or migrations. Such changes need a separate ordinary engineering PR. Task prose and
incident evidence never become shell commands or permission to change the fixed acceptance rules.
Product/cost loops must include their replay/cost comparison. AI loops require an AI holdout result.
The normalized contract materializes CI, review coverage and stable-snapshot gates; merge/deployment
targets add the existing delivery collector's concrete milestone IDs. Required external review adds
an approval gate. Missing IDs therefore cannot waive the selected policy, even through checkpoint
assessment. Delivery milestones are evaluated after source repair, at their corresponding stage.
The delivery collector emits `review-approval` separately from thread resolution, while AI uses the
existing `ai/offline-holdout` producer; offline success does not prove live model quality. Frozen AI
labels are protected from repair paths. Review waits are capped at 900,000 ms (15 minutes).
Loop callers pass the selected target to `collectDelivery`/`assessDelivery`; milestones after that
target are optional and deployment artifacts are fetched only for deployment targets. The existing
`harness delivery` CLI keeps its full-deployment default. Browser acceptance/configuration under
`e2e` is also protected from automatic repair scope.

Create a journal with `vp run harness loop init <spec.json> <state.json>`; inspect it with
`vp run harness loop history <state.json>`. Journals extend the existing checkpoint storage primitive:
exclusive writer locks, optimistic revisions, synced temporary files and atomic replacement preserve
the last complete state. Events are append-only, ordered and chained to the contract digest. This
detects accidental edits, not a malicious writer able to replace the whole journal. Preserve journals
as CI artifacts or operator-owned task files. An abandoned lock needs deliberate writer-liveness
checking before removal. Inspecting history does not execute its contents or restart a stopped run.
The parent directory is synced after replacement. Both append and read enforce the same serialized
journal size ceiling, so a successful write cannot create a journal rejected by the reader.
Lock removal is synced as well. Event data must be plain JSON: non-finite numbers, undefined,
accessors, sparse arrays and class instances are rejected; stored payloads are detached from callers.

`vp run harness loop status <state.json>` reconstructs the controller state from the journal.
An attempt reserves its external calls and microdollar allocation before execution. Interrupted work
keeps those charges when deliberately resumed. Unknown/skipped/missing or stale-SHA evidence blocks
progress; a source pass advances to review, not deployment/completion. The controller binds the same
required checks as checkpoints, including explicitly requested comparisons. Repeated failures without
improvement, the iteration ceiling and the original wall-clock deadline stop the run. Heartbeats do
not extend deadlines or count as progress. A terminal run requires a new contract/run to try again.
Source acceptance also requires the complete Git change list bound to the frozen baseline and
candidate SHA. `collectLoopScope` records this evidence; protected paths, existing acceptance-test
edits, symlinks/gitlinks and mode changes block the attempt. Requested comparisons must name the
contract's baseline. A passing JSON assertion alone cannot replace these collector inputs.

`loop ingest <signal.json> <index.json>` normalizes CI/product/cost/AI signals and returns a bounded
contract. Identity is repository + kind + source SHA + failure key; retries update the same item,
and out-of-order signals cannot move lastSeen backwards. Preserve the index with run artifacts.
`loop intake-ci <owner/repo> <run-id> <directory>` reads a complete, bounded GitHub CI job snapshot,
writes deduplicated contracts and retains the evidence links. It rejects incomplete job coverage and
ignores foreign repositories and `automation/loop/` branches already owned by an existing loop.
Automatic intake accepts only main push failures. An explicit manual dispatch (or the CLI's final
`manual` mode argument) may select a same-repository feature run; its whole baseline must be reviewed.

The `autofix.ci` workflow’s `loop-intake` job collects failed CI runs from trusted main code, with read-only
GitHub permissions and no provider/production credentials. Its artifacts are an intake handoff, not
proof a repair ran. Stable task IDs let an executor reuse the same journal/worktree across repeated
artifacts; it must not reset an existing run's budget. No new production scan or duplicate schedule
is introduced. Operational reports and confirmed admin corrections use the same signal interface.

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

Local runners record paths relative to the repository root, including the selected output directory.
Use output directories within the repository (normally `.generated/` or `test-results/`); extract CI
artifacts back under the same root layout to resolve those references. A report may live outside its
sample directory. Empty or absent cost-sample directories still produce all required unknown checks;
before/after comparisons continue to require nonempty measurements.

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

## Workers AI holdout and review feedback

`vp run harness ai-template .generated/ai-recording.json` writes a new, intentionally incomplete
recording template for 20 cases across 10 product families outside the TAD/LS50 development canary.
Positive spellings come from shop/identity regressions and manufacturer sources; negative candidate
mutations are synthetic counterexamples. Corpus v2's
[source review](../../evaluations/workers-ai/2026-09-13-holdout-label-review.json) binds every label
to its snapshot and records changes made before model measurement: an ambiguous DENON color alias
was replaced by a different-model case, and the unverified SA-10 SE positive became official SA-10.
The review is independent of model responses and explicitly does not claim a separate human
reviewer. The existing live-canary record and policy approval are unchanged.

The [v2 real-model recording](../../evaluations/workers-ai/2026-09-13-holdout-v2-qwen3-prompt3.json)
and [evaluation](../../evaluations/workers-ai/2026-09-13-holdout-v2-evaluation.json) retain the failed
prompt-3 result: 14 provider calls, six deterministic abstentions, 80% positive recall and five
invalid null-ID/non-null-evidence responses rejected by the runtime. Measured usage and latency
are separate from reservations and production metrics. The CI regression replays those observations
without inference and expects the failed model gate; it must not repair responses to make it pass.
The recording names the clean source commit used to freeze requests. Replaying it on a different
checkout cannot establish that newer SHA's completion through the common report's source gate.

The original request source is retained on the dedicated
`evidence/ai-holdout-v2-20260913` branch, independently of the squash-merged PR branch. Retain this
evidence branch. To inspect or reproduce that source, fetch it explicitly (including in a shallow
clone), verify its recorded SHA, and create a separate checkout:

```bash
git fetch origin refs/heads/evidence/ai-holdout-v2-20260913
git rev-parse FETCH_HEAD
git worktree add --detach ../hifiscout-ai-holdout 0bc041f9579b3035dedf4609977affa59aaad322
```

`FETCH_HEAD` must equal the SHA in the recording's `sourceSha`/`measurement.sourceArchive`.
After installing that checkout's locked dependencies, pass the recording from the newer checkout
to its `harness ai` command and use a new output directory inside the source checkout. This
replays responses offline; it makes no new AI requests. The expected result is still `fail`.

The template binds each runtime-built request to its snapshot fingerprint, corpus digest and exact
policy key. Fill model-required `attempts` with recorded `model`, nullable `requestId`, `requestedAt`,
raw schema-2 `response`, nullable `latencyMs`, and `usage` containing nullable `inputTokens`,
`outputTokens` and `neurons`. Keep deterministic cases' request null and attempts empty. This command
does not call Workers AI. Normal CI uses explicitly stubbed responses to verify the evaluator.

`vp run harness ai <recording.json> .generated/ai-<run-id>` preserves the recording, evaluation and
common report. It separately reports pipeline outcomes, actual model-case outcomes, deterministic
veto counts, attempts, invalid responses, per-attempt latency and nullable provider usage. Missing
responses remain unknown; unsafe observed output fails even if another case is missing. A provider
ID cannot be counted twice. Unavailable usage is never converted to zero or an estimated actual cost.

An optional case `review` contains `decision` (accepted/rejected), `actor`, `reason`, `reviewedAt`,
the same `fingerprint` and `responseDigest` (SHA-256 of JSON.stringify of the final wire response).
Reviews bind to that precise response; accepting an absent/invalid suggestion is rejected. Optional
`groundTruthReview` binds `actor` and `reviewedAt` to `corpusDigest`. Acceptance rate, pending
suggestions and false accepted suggestions remain separate from model correctness.

Attempt timestamps must increase strictly. Out-of-order or tied retries cannot replace the final
response or move the review cutoff backwards; reviews must follow the last recorded attempt.

Offline output always states that provider/reviewer provenance is unverified, live evaluation is
unknown, and activation is not approved. Passing fixtures cannot enable inference, change the
approved policy, bypass identity vetoes or grant account budget. Independent label review and real
provider evidence are needed for any future live evaluation/activation decision.

## Extending an existing boundary

The canonical development command inventory is in [tooling](../../docs/tooling.md); CI scheduling,
cache keys and artifact ownership are in the [workflow responsibility map](../workflows/README.md).

Reuse package scripts, Vitest, Playwright, real migrated local D1 fixtures and deployment-owned
identity artifacts. Add a diagnostic at the boundary that owns the behavior. Keep orchestration
thin, execute bounded commands and leave concise machine-readable results for the next session.
