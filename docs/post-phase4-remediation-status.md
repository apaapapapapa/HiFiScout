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
table reads are recorded there, each with the change that would remove it:

| Query | Reads | Why the index does not apply |
| --- | --- | --- |
| Queue claim | `data_quality_remediation_queue`, plus a sort | Claimable states are an `OR` over different columns, and `ORDER BY priority DESC, available_at, id` disagrees with the partial index column order. A `UNION ALL` per state would use `idx_dq_remediation_queue_claim`. |
| Replay seeding | `products`, every five minutes | The staleness CTE tests four resolver versions in `CASE` branches, so no single index applies. One selector per resolver, each against its own version index, would bound it. |

Each allowance names the statement it covers, so an exception earned by one query cannot excuse a
new scan in another, and an allowance that stops matching fails the test — the list only shrinks.

Reading a plan correctly matters more than it looks. `SCAN t USING INDEX i` walks an index in
order and is what these tests are asking for; only a bare `SCAN t` is a row-by-row table read.
Two earlier candidate findings did not survive that distinction:

- the price-sort page **does** use `idx_product_search_entities_price`. It only appeared not to
  because the plan had been measured against an empty `product_search_entities`;
- the unresolved-identity grouping **does** use `idx_products_identity_group`, which the test now
  asserts by name rather than by checking that the SQL contains `LIMIT` — the `LIMIT` follows
  `GROUP BY`, so it bounds rows returned, not rows read.
