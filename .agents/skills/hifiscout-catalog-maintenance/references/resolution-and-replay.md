# Resolution and replay

Start with [resolution versions](../../../../src/catalog/resolution-versions.ts),
[data-quality remediation](../../../../docs/data-quality-remediation.md),
[listing diagnosis and replay](../../../../docs/listing-admin.md) and
[replay status](../../../../docs/resolver-replay-status.md).

## Diagnose the owning boundary

Trace representative listings through seller fields, extracted manufacturer/model/category,
manual overrides, verified catalog candidates, identity decisions, projection obligations and
public membership. Include counterexamples: another revision, compatible accessory, included
accessory, bundle, second listing on the same page and already-correct data. A search for a maker
can fail in extraction, identity or query filtering; inspect the actual API predicate before
changing the catalog to fit the UI result.

Preserve the distinct grouping paths: verified catalog `matched` membership and guarded exact
manufacturer/model fallback. Candidate/fuzzy aliases and category hints do not authorize a merge.
Do not erase revision or accessory evidence to reduce duplicate cards. Unmatched listings must
remain findable; a catalog-only result set cannot silently discard them. Check entity counts,
same-offer filters, representative prices, sorting/page boundaries and history where affected.

Fix the shared domain owner or the reproducible shop parser defect. Verify retained inputs against
old/new decisions; inspect newly automatic matches especially closely. Add semantic fixtures and
counterexamples at the smallest useful layer, then verify the affected persisted projection and
write budget when that boundary changes. An improved classification ratio cannot excuse a false
product merge. Consult [testing strategy](../../../../docs/testing-strategy.md) for existing corpora.

Reuse the [harness product replay](../../../../.github/harness/README.md) artifacts for the current
CI graph where available; they already import the normal unit shards. For a before/after comparison,
use clean source checkouts and the maintained `replay` / `compare-replay` commands. A changed
corpus, missing case or local fixture success cannot establish a production accuracy improvement.

## Select and observe reprocessing

Determine the dependency that changed: resolver version, manufacturer registry generation,
catalog identity/category/verification state or listing evidence. Inspect the current selection
predicate and mutation path; do not assume that bumping a version or deploying a change processes
all retained data. Do not increment unrelated versions just to force a sweep.

| Need | Current path to inspect |
| --- | --- |
| Title/condition offer facts | Bounded offer-fact replay in listing admin; no seller detail refetch |
| Old model/category versions or pending projections | Shared admin resolver replay job and `src/db/admin-resolution-replay.ts` |
| Manufacturer alias change | Registry generation and the existing manufacturer re-resolution job |
| Catalog edit/create | Admin operation/CSV receipt, affected-listing discovery and catalog remediation watermark |
| Broader stale identity/projection maintenance | Scheduled remediation or explicitly invoked Resolver Replay Drain |

Use current contracts for active/inactive scope, horizon and rule tuple. Keep stable IDs, durable
cursors, bounded candidate windows, same-value skips and pending downstream work. An unchanged
canonical value alone is not a skip condition if its projection is pending or dependency evidence
is stale. Recheck queued candidates before applying, retain manual overrides, and advance only
after durable completion. Preserve concurrent-edit guards and stop on the current retry/conflict
limit instead of looping across a persistent failure.

When a deployment invalidates a pinned replay tuple/scope, follow that job's documented stop and
restart path; do not silently continue under changed rules. Existing admin model/category replay
is not automatically a full catalog/master or all-resolver audit. Full coverage requires accounting
for skipped rows, captured horizons, failed targets and pending projections separately. Replay
convergence does not authorize enabling paused operational audits or launching a full scan.
