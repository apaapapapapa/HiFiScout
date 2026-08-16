# Post-Phase-4 remediation: measured status

Where the remediation program actually stands, measured rather than assumed. Compare against
[post-phase4-data-quality-baseline.md](post-phase4-data-quality-baseline.md), captured 2026-08-14.

Production figures below are from the `Deploy Cloudflare` run for merge commit `c51811f`
([run 31892219451](https://github.com/apaapapapapa/HiFiScout/actions/runs/31892219451),
2026-08-15T15:16Z). Every deploy prints the same report, so these numbers are re-derivable.

## Production data quality

| Metric | Baseline | 2026-08-15 | Δ |
| --- | ---: | ---: | ---: |
| Active listings | 6,933 | 7,078 | +145 |
| Manufacturer unknown | 83.15% | 81.79% | **−1.36pt** |
| Category unclassified | 51.05% | 57.84% | **+6.79pt** |
| Identity unresolved | 98.50% | 98.14% | **−0.36pt** |
| Matched active listings | 104 | 132 | +28 |
| Identity resolution coverage | 100% | 100% | — |

Per shop, category unclassified moved most at Fujiya-Avic: 8.54% → 31.29% (+22.75pt). Audio Union
improved on manufacturer (72.13% → 60.81%) and worsened on category (72.13% → 75.68%).

## Backfill is incomplete, not stalled

| Signal | Value |
| --- | ---: |
| Listings still behind the current resolver versions | 4,657 of 7,078 |
| Remediation queue pending / resolved / failed | 480 / 182 / 0 |
| Field changes recorded so far (model/category/identity/manufacturer) | 23 / 21 / 14 / 8 |

The sweep runs on the five-minute cron with the repository defaults — seed 50, claim 10 — so it
seeds faster than it drains by design, and the backlog grows until seeding runs out of stale rows.
At 10 listings per 5 minutes, 4,657 stale listings take roughly 39 hours to drain unattended. The
zero failure count says the queue is healthy; it is simply early.

Because the metrics above were sampled at roughly 4% of the backfill, they describe a system in
transition, not a finished state.

## The category movement needs a decision

The category metric is worse than the baseline, and the remediation queue does not explain it: only
21 category changes have been recorded by replay, against roughly 450 additional unclassified
listings at Fujiya-Avic alone. The remainder arrives through the crawl path, where the stricter
evidence-based classifier introduced in
[#155](https://github.com/apaapapapapa/HiFiScout/pull/155) replaced the looser one the baseline was
measured with.

That leaves two readings, and they call for opposite work:

1. the stricter classifier is right, the old 8.54% was over-confident guessing, and the baseline is
   the number that needs restating; or
2. the classifier is over-strict and a rule needs fixing.

Section 18 is explicit that a worsening metric is fixed at the rule, not hidden, so this is tracked
here rather than absorbed into a threshold change.

## Query plans (section 16)

`test/remediation-query-plans.test.ts` explains the SQL the repositories actually issue. Two full
table reads were recorded there. Both are fixed and the recorded list is empty:

| Query | Was | Is |
| --- | --- | --- |
| Queue claim | Read `data_quality_remediation_queue` end to end, then sorted it — the claimable states are an `OR` over different columns, and `ORDER BY priority DESC, available_at, id` disagreed with the one claim index. | A `UNION ALL` per state. Each branch walks `idx_dq_remediation_queue_pending` / `idx_dq_remediation_queue_processing`, which are already in claim order, and stops at `LIMIT`; the outer sort sees at most two batches. `idx_dq_remediation_queue_claim` had no other reader and is dropped. |
| Replay seeding | Read every listing, every five minutes — the staleness CTE was one disjunction over ten columns, which no index can serve. | Five bounded selectors, each naming its index with `INDEXED BY` and ordering by what that index already delivers, so a tick is five index seeks of one page each. |

Migration 0027 split the selector; **0028 is what made the split bound anything**, and the gap
between those two is the part worth remembering.

**An index is not a bound if a sort sits between it and the `LIMIT`.** Three of 0027's selectors read
through an index and then collected every matching row into a temp b-tree, because `ORDER BY id`
disagreed with the order the index delivered. Ordering by `(version, id)` instead — the index's own
order — lets the plan stream and stop. The test now fails on `USE TEMP B-TREE FOR ORDER BY` in any
seeding plan, which is the property that actually matters and the one "reads through an index" hides.
Getting there also meant selecting the driving table's spelling of a column: `r.listing_product_id`
rather than `p.id`, and a bare `r.identity_resolver_version` rather than a `COALESCE` over it, since
SQLite cannot order on an expression using the index underneath it.

**A range on the leading column ends the usable prefix.** 0027's version indexes were
`(version, is_active, id)`, so a catalog full of retired listings on an old resolver version would be
read and discarded one entry at a time. 0028 makes `is_active` a partial-index predicate instead of a
key column, which keeps inactive rows out of the index entirely and leaves the key columns free to
match the selector's order. Leading with an `is_active` equality would also have worked for the
selector — and did visible damage elsewhere: it made the version indexes look attractive to unrelated
listing queries, and the unresolved-identity dashboard query immediately switched off
`idx_products_identity_group` onto one of them.

**Still-unresolved is a result, not a signal.** 0027 gave "manufacturer unresolved", "category
unclassified", "identity unresolved" and "identity row missing" an index each, which fixed the plan
and not the cost: their candidate set is the persistent unresolved catalog, so every tick walked all
of it, probed the queue once per row, and — once the deterministic work keys were queued — returned
nothing. Replaying the same resolver version over the same listing produces the same answer, so those
four are gone from automatic seeding. What remains is the two things that genuinely mean *stale*:

- a resolver version behind the current one (manufacturer, model, category, identity), and
- `remediation_projection_required`, the dirty flag a failed downstream refresh leaves behind.

Both self-clear, so a drained stage costs a seek that finds nothing. An outcome that changes because a
*dependency* changed is already covered, bounded and cursor-restartable, elsewhere:
`reprocessManufacturerAliasListings` on alias verification, `reprocessPendingCatalogRemediation` on
catalog verification, and `reclassifyProductsFromKnowledgeCatalog`, which sets the projection flag and
so arrives back in this queue. Re-running everything regardless is the explicit, paged
`enqueueFullDataQualityRebuild`.

One property did change: seeding pages are now taken in stage order rather than by listing id, so a
long backfill in an early stage can delay seeding of a later one. That ordering matches the priority
the old `CASE` already encoded, and every stage's page is read whether or not the budget is full.

The allowance mechanism stays. Each entry names the statement it covers, so an exception earned by
one query cannot excuse a new scan in another, and an allowance that stops matching fails the test —
the list only shrinks.

Reading a plan correctly matters more than it looks. `SCAN t USING INDEX i` walks an index in
order and is what these tests are asking for; only a bare `SCAN t` is a row-by-row table read.
Two earlier candidate findings did not survive that distinction:

- the price-sort page **does** use `idx_product_search_entities_price`. It only appeared not to
  because the plan had been measured against an empty `product_search_entities`;
- the unresolved-identity grouping **does** use `idx_products_identity_group`, which the test now
  asserts by name rather than by checking that the SQL contains `LIMIT` — the `LIMIT` follows
  `GROUP BY`, so it bounds rows returned, not rows read.
