# Saved-search notification initial load review

Base: `c678e727ffe3cc20d351344a25f00cba87479504`.
Initial measured fixture head: `af3478b34cbfe2a93e1a3fc457a982b33ba19c88` (clean checkout).

This feature adds an independent opt-in Web Push scheduler. Existing D1 workloads, ceilings and
fixtures are retained. New cases use the pinned toolchain with real Miniflare D1 / workerd SQLite,
not a production database or a real notification recipient.

| Case | Observed reads / writes / statements | Initial ceiling |
| --- | --- | --- |
| Twenty changed listings among 10,000 older listings | 20 / 0 / 1 | 50 / 0 / 1 |
| Same-offer search of those twenty IDs (FTS, shop, price, stock, latest price history) | 78 / 0 / 1 | 1,000 / 0 / 1 |
| Persisted notification outbox replay, including VAPID/watch lookups and constant-time capacity check | 6 / 0 / 5 | 10 / 0 / 5 |

The indexed candidate range does not grow with unrelated retained products. Matching is driven
from a bounded JSON ID list and correlates category, FTS and specification predicates to that
entity. The matching allowance leaves room for those predicates, but does not guarantee every
production distribution fits. Daily D1 reservations persist before queries; unavailable native
usage stops further reads. Durable delivery counters prevent the capacity check from scanning
the whole ledger, and duplicate INSERTs preserve zero physical writes.

Functional coverage checks wrong-shop/over-budget/sold-out offers, first observation independent
of source publication date, stale price-history suppression, UTC budgets, missing D1 metadata,
duplicate scans, failed transaction rollback, three-attempt retries, subscription expiry, ownership
isolation and removal of queued deliveries. The idle-resume regression was measured again at clean head `86d9ec4d55d2edbc8e0cb8ecf14a0aa06eee957c`: replay remains 6 / 0 / 5, and stopping/restarting preserves the same-day budget. Cryptographic tests independently decrypt the payload
and verify VAPID; browser tests mock permission/subscription APIs without external delivery.

These are new absolute baselines: there is no invented pre-feature notification measurement.
The load-review record seals their exact fixture profiles, measurements, ceilings and base.
Production CPU, SQLite billing, arrival rate, device delivery rate and capacity remain unmeasured.
