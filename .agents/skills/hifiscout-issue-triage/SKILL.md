---
name: hifiscout-issue-triage
description: "HiFiScoutのIssueの受入条件・実装・証跡を再評価し、更新内容やクローズ可否を判断するときに使う。"
---

# HiFiScout issue triage

Read the latest issue requirements/comments and relevant linked PRs; compare with current `main`.
Preserve accepted scope changes. Historical labels, checklists and architecture are not current proof.
Use the domain references needed to judge the claim, not every skill named in an old issue.

## Match evidence to acceptance

Summarize each criterion with its evidence (SHA/run/artifact/interval), status and gap/next action.
Keep `pass`, `fail`, `unknown` and `skipped` distinct. Code removal/supersession can be established from
source; collect deployed/operational evidence only when the criterion depends on it.

| Criterion | Evidence boundary |
| --- | --- |
| Source behavior / replacement design | Current implementation and relevant checks/PRs |
| Production rollout | Deployment identity and downstream receipts; see [delivery](../hifiscout-delivery/SKILL.md) |
| Load/baseline | Coverage and comparable workload; see [SQL observation](../../../docs/d1-sql-observation.md) |

A deploy workflow can be green and deferred/no-op. Missing/expired artifacts or quota-blocked metrics
stay unknown, not zero; hourly archive presence does not prove account-wide completeness. Preserve
paused audits. A required unmeasured criterion stays unresolved unless its requirement is explicitly
changed; an old audit command does not authorize new production scans.

For a fixed-deployment observation requirement, use an already accepted alternative if one exists.
Otherwise propose deployment segments or equivalent code/config/schema cohorts with comparable
workload, disjoint hours, coverage/exclusions and independent correctness evidence. State which
requirement changes and what confidence is lost. Mixed versions never silently satisfy a fixed-version
baseline; a historical 72-hour rule does not apply to every issue. A recorded proposal is not acceptance.

## Finish within the requested scope

Close as completed only with evidence for current accepted criteria. For an obsolete problem, explain
the superseding design/PR and appropriate superseded/not-planned decision; do not claim missing original
measurements passed. If work remains, narrow to the actual gap and a concrete next action.

Review-only work returns the decision/draft. For authorized updates/closures, reread before writing,
preserve intervening edits and useful evidence, apply the scoped update and verify the final body/state.
If implementation is requested too, complete it via delivery rather than stopping at another issue.
