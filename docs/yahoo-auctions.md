# Yahoo! Auctions audio integration

Tracked by [#703](https://github.com/apaapapapapa/HiFiScout/issues/703). Implementation and public
activation are separate decisions. Collection and publication default to disabled. This document
records the contract and activation prerequisites; it does not certify a working production source.

## Data ownership and price semantics

Existing shops and the canonical Knowledge Catalog stay on D1. Yahoo listing state and its search
will use a dedicated SQLite-backed Durable Object. Do not write bidding prices into retail products,
retail price history, minimum-price summaries or the existing Price Index. Public requests read saved
facts only and never fetch the seller.

`src/api/auction-contracts.ts` owns the independent observation vocabulary. Prices, bids, shipping,
tax status, sale subject and sale unit retain unknown values. A one-yen starting bid is a bidding
price, not a one-yen retail offer. A last observed price is not a winning bid or proof of a sale.
`src/auctions/observation.ts` validates detail URL/ID agreement, bounded factual fields and canonical
UTC instants. An expired scheduled end becomes `end_confirmation_pending`, not confirmed ended.
Ordering uses request start rather than response delivery. Reopening an ended identifier requires
explicit evidence of a new start after the old ending observation.

## Source and activation evidence (2026-09-19)

- [Official API notice](https://developer.yahoo.co.jp/changelog/2018-02-20-auction160.html): the old
  public auction API ended on 2018-02-22. No replacement API or contracted feed has been established
  for this integration.
- [LINE Yahoo terms](https://www.lycorp.co.jp/ja/company/terms/): public visibility is not treated as
  authorization for recurring collection or republication. Record the applicable permitted scope.
- The audio category root `23764` was visible on the official category page. Child category scope
  must be reviewed explicitly; promotional/related-category links must not expand the allowlist.
- The current robots file and representative source HTML could not be retrieved in this session.
  Parser fixtures are not yet source-validation evidence. Do not enable collection on that basis.
- [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and
  [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) were
  checked. Actual account headroom and Yahoo runtime costs are still unmeasured. Existing crawl DOs
  share account allowances. Alarm writes, indexes, deletions and recovery count toward the budget.

`src/auctions/config.ts` owns bounded proposed limits and independent collection/search/public
switches. Collection additionally needs an HTTPS approval-evidence reference, explicit source-fixture
validation, account-budget review and a nonempty reviewed category allowlist. Those settings are
operator attestations, not automatic proof of permission or coverage. Invalid configuration fails
closed. Do not turn the root category into an enabled whole-inventory crawl by default.

## Implementation sequence

1. Independent observation contracts, defensive validation and activation gates.
2. Source parser/transport, reviewed category mapping and bounded discovery/rechecks.
3. SQLite DO schema, atomic receipts/cursors, paced Alarms, pause/recovery and metered retention.
4. Bounded cached D1 identity matching and versioned targeted reconciliation.
5. Separate auction search, product-detail links and authenticated administration.
6. Limited activation only after source and budget evidence; widen scope from measured results.

Use separate PRs referencing #703. Preserve the shared 23:00–08:00 JST collection pause, including
manual and recovered work. A partial listing traversal never expires missing items. Unknown source,
quota or telemetry results remain unknown. Do not close #703 merely because preparatory code merges.
