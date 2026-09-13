# Resolution and replay

For derivation/version changes, inspect [resolution versions](../../../../src/catalog/resolution-versions.ts)
and relevant [remediation](../../../../docs/data-quality-remediation.md) sections. Select replay guidance
below only if stored data must be reprocessed.

## Diagnose the owning boundary

Trace representative listings through seller fields, extraction, manual overrides, catalog candidates,
identity decisions, projection obligations and public membership. Include affected counterexamples such
as another revision, compatible/included accessory, bundle or second listing on a page. Check the actual
API predicate before changing catalog identity to fit a manufacturer search result.

Keep verified catalog `matched` membership separate from guarded exact manufacturer/model fallback.
Candidate/fuzzy aliases and category hints never authorize a merge. Unmatched listings stay findable;
a catalog-only result cannot silently discard them. Preserve revision/accessory evidence and verify
same-offer filters, entity counts, prices, pagination and history where affected.

Fix the shared domain owner or reproduced parser defect. Compare old/new decisions on retained inputs,
especially new automatic matches. Add semantic regressions/counterexamples at the smallest useful layer;
verify projection completion and write budgets when those boundaries change. Better classification
coverage cannot excuse a false merge. Use the existing [test corpora](../../../../docs/testing-strategy.md)
and [harness replay](../../../../.github/harness/README.md) evidence where applicable. Normal CI imports
its unit shards; use clean checkouts for `replay`/`compare-replay`. Changed corpora or local fixture passes
cannot establish production accuracy improvement.

## Select the actual reprocessing dependency

Inspect the current selection/mutation contract for the changed resolver version, manufacturer registry
generation, catalog evidence or listing input. Deployment/version bumps do not prove all data was
processed; never bump unrelated versions to force a sweep.

| Dependency / need | Maintained path |
| --- | --- |
| Title/condition offer facts | [Offer-fact durable job](../../../../docs/listing-admin.md#bounded-offer-fact-replay); retired foreground POST returns 410 |
| Old model/category versions or pending projections | [Model/category job](../../../../docs/listing-admin.md#bounded-model-resolver-replay), `src/db/admin-resolution-replay.ts` |
| Manufacturer aliases | Registry generation and existing manufacturer re-resolution job |
| Catalog additions/edits affecting stored listings | [Catalog job](../../../../docs/listing-admin.md#catalog-change-replay), `src/db/admin-catalog-replay.ts`; import receipts and remediation watermark |
| Broader stale identity/projection maintenance | Scheduled remediation or explicitly invoked [Resolver Replay Drain](../../../../docs/data-quality-remediation.md#resolver-replay) |

Current job contracts own active/inactive scope, captured horizon and rule tuple. Preserve stable IDs,
durable cursors, bounded windows, manual overrides and concurrency guards. An unchanged canonical value
is not enough to skip stale evidence or pending projections. Recheck candidates before applying and
advance only after durable completion; respect retry/conflict limits.

When deployment invalidates a pinned tuple/scope, use the documented stop/restart path. Account for
skipped/failed targets, captured horizons and pending projections; model/category replay alone does
not prove a full catalog/all-resolver audit. Replay convergence does not authorize paused audits or a
full production scan. Report code completion and retained-data convergence separately.
