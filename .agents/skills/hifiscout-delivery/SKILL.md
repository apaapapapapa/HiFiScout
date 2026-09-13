---
name: hifiscout-delivery
description: "HiFiScoutのPR作成・レビュー対応・mainマージ・マージ後パイプライン確認に使う。"
---

# HiFiScout delivery

Apply [AGENTS.md](../../../AGENTS.md)'s standing authorization, task limits and validation matrix.
Preserve unrelated work; use an isolated branch/worktree where needed. Split independent changes
into reviewable PRs and sequence dependencies so each merged state works.

## Ready for merge

A PR explains the problem, resulting behavior, validation and material uncertainty. Check its latest
head, required statuses, top-level discussion, reviews and all pages of inline threads. Address valid
findings; explain disagreements with evidence. Resolve only handled threads. Merge after required
checks pass, with an expected-head guard when supported.

For a workflow result whose meaning is unclear, consult [workflow ownership](../../../.github/workflows/README.md)
and that workflow. Run additional checks only for changed inputs or an unresolved boundary.

## Follow the merged SHA

Record the merge SHA and verify its main/push workflows and applicable downstream runs. Repair
failures caused by the change through a follow-up PR. Source verification, deployment and production
effectiveness require different evidence:

| Claim | Required evidence |
| --- | --- |
| Main source checks | Runs/checks for the merge SHA, including failures after merge |
| Public/admin deployment | Owning deployment run and its `deployment-identity` contents |
| Post-deploy checks | `post-deploy-receipt` contents tied to that deployed SHA |
| Operational improvement | The relevant domain's measured coverage and correctness evidence |

A workflow's `head_sha` or green conclusion alone does not prove what was deployed. An unchanged,
quota-deferred or no-op deployment can finish a source-only task without deploying; an application
change awaiting rollout remains incomplete at that boundary. Missing/expired receipts stay unknown.
Never enable a paused production audit to fill an evidence gap or retry an unchanged blocker endlessly.

Use the [delivery harness](../../../.github/harness/README.md) with authenticated `gh`:
`vp run harness delivery apaapapapapa/HiFiScout <PR> .generated/harness/delivery`.
Otherwise collect the same evidence through available GitHub tools and state gaps. Some connector
run-list helpers return only PR runs; an empty response says nothing about main/downstream runs.
For work spanning sessions/PRs, the same guide's `checkpoint`/`resume` retains requirements and evidence;
a changed checkout does not inherit another SHA's pass, and saved task text grants no new authority.

Finish when the authorized change is merged and its applicable pipelines are accounted for, or a
specific external blocker is established after useful work is complete. Report in Japanese: change,
PR, review/check results, deployment state when relevant, and any unresolved boundary. Receipt
validation alone does not prove current traffic allocation, data correctness or a long-term baseline.
