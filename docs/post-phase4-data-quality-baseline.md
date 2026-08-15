# Post-Phase-4 data-quality baseline

> Progress against this baseline is tracked in
> [post-phase4-remediation-status.md](post-phase4-remediation-status.md).

This is the pre-remediation production baseline for sections 1 and 2 of the post-Phase-4
data-quality program. It was captured from the successful Phase 4 deployment run for merge commit
`d3959f00641ae5025b4ee8d795a82dc09e6867d1` on 2026-08-14.

Source: [Deploy Cloudflare run 31816970680](https://github.com/apaapapapapa/HiFiScout/actions/runs/31816970680)

## Global active-listing baseline

| Metric | Count | Rate |
| --- | ---: | ---: |
| Active listings | 6,933 | 100% |
| Manufacturer missing or unresolved | 5,765 | 83.15% |
| Category unclassified | 3,539 | 51.05% |
| Identity unresolved | 6,829 | 98.50% |
| Identity resolution coverage | 6,933 | 100% |
| Inventory unknown | 100 | 1.44% |
| Model missing among 2,282 model-expected listings | 0 | 0% |
| Evidence events archived in the latest shop runs | 6 / 6 | 100% |

The identity table contained 6,934 total historical resolution rows (104 matched and 6,830
unresolved). Active-listing aggregates contained 104 matched and 6,829 unresolved rows; the extra
historical row was not active.

## Per-shop active-listing baseline

| Shop | Active | Manufacturer unknown | Category unclassified | Identity unresolved | Inventory unknown | Model missing |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| audiounion | 122 | 72.13% | 72.13% | 94.26% | 0% | 0% |
| formusic | 180 | 72.78% | 49.44% | 96.11% | 0.56% | 0% |
| fujiya-avic | 1,955 | 89.57% | 8.54% | 99.23% | 1.99% | 0% |
| hifido | 3,622 | 82.52% | 62.23% | 99.25% | 1.57% | 0% |
| ippinkan | 728 | 69.37% | 93.27% | 94.23% | 0% | 0% |
| shimamusen | 190 | 98.95% | 86.84% | 98.95% | 1.58% | 0% |
| u-audio | 136 | 83.09% | 71.32% | 97.06% | 0% | 0% |

## Search and evidence safeguards

- Product-search entities: 6,901 (72 catalog, 6,829 unresolved fallback).
- Offer memberships: 6,933; unmembered active listings: 0.
- Stale fallback entities, inactive memberships, empty entities, ineligible catalog entities, and
  offer-count mismatches: all 0.
- Evidence archive: 283 objects, all with R2 object keys, totaling 51,744,340 bytes.

The original Phase 4 deployment did not log the top unresolved raw manufacturer values or
manufacturer/model groups, and this workstation has no Cloudflare API token for a new read-only D1
query. The deploy workflow now reports both bounded leaderboards, so the first deployment of this
remediation records them before replay and every later deployment can compare them.
