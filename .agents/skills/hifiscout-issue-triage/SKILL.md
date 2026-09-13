---
name: hifiscout-issue-triage
description: "HiFiScoutのIssueを最新実装・PR・観測証跡から再評価し、更新案やクローズ判断を作る。Use for obsolete/completed issue cleanup and acceptance/baseline assessment; mutate issues only when requested or already authorized."
---

# HiFiScout issue triage

## Reconstruct the current requirement

Read the latest issue body, all relevant comments, linked PRs and their review/merge state. Compare
with current `main`, deployed identity and current operational configuration. Old issue labels,
checklists and historical Queue architecture are not proof of current behavior. Preserve the
user's latest accepted scope changes instead of restoring superseded requirements from history.

Use the relevant domain skill for the technical judgment and the
[harness evidence contract](../../../.github/harness/README.md) plus
[workflow ownership](../../../.github/workflows/README.md) for CI/deployment interpretation.
Do not collect production data merely because an issue contains an old audit command.

## Assess each acceptance condition

Build a compact table: criterion, current evidence (SHA/run/artifact/interval), status, gap or next
action. Keep `pass`, `fail`, `unknown` and `skipped` distinct. CI source success, main merge,
deployment, production convergence and observed cost reduction are different claims.

- Require evidence from the source/deployment and observation window the criterion actually
  covers. A newer implementation may supersede the original fix, but show that mapping explicitly.
- A successful deploy workflow may be deferred/no-op. Inspect `deployment-identity` and the
  downstream receipts rather than using run `head_sha`. Missing/expired evidence remains missing.
- For load/baseline criteria, use [SQL observation semantics](../../../docs/d1-sql-observation.md).
  Quota gaps, truncated groups, sampled data and missing CPU/Queue metrics cannot become zero.
  A full set of hourly archive files is not a complete account-wide measurement.
- Keep intentionally disabled health/audit checks disabled. Distinguish passive archive jobs
  from active D1 scans. Optional paused checks can be skipped, but a required unmeasured condition
  remains unresolved unless its acceptance requirement is explicitly changed.

If a fixed-deployment observation window cannot coexist with continuous releases, first check
whether an alternative has already been accepted. Otherwise propose a concrete comparison:
deployment segments, relevant code/config/schema equivalence, comparable traffic/crawl workload,
nonoverlapping hours, coverage thresholds, exclusions and independent correctness evidence. State
which original requirement it replaces and what confidence is lost. Do not silently label mixed
versions as a fixed-version baseline or impose a historical 72-hour rule on unrelated issues.
An already-authorized issue update can record this proposal without claiming it was accepted.

## Decide and update within scope

Close as completed only when current accepted requirements are evidenced. If the problem no longer
applies, explain the superseding design/PR and use the appropriate superseded/not-planned decision
rather than pretending the original measurements passed. If work remains, narrow the issue to the
actual gap and identify a concrete next action. Do not close solely because a PR merged.

For a review-only request, return the decision and draft update. When issue updates/closures are
authorized, reread the issue before writing, preserve intervening edits and useful evidence, make
the scoped update, and verify the resulting body/state. Avoid rewriting history or duplicating old
checklists in a new issue without a reason. If implementation is also requested, use delivery to
complete it; do not stop at filing another issue instead of doing the authorized fix.
