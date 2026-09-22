# Yahoo! Auctions: gated audio pilot

Status: offline foundation only; collection and public serving are **not approved or enabled**.
Issue: [#703](https://github.com/apaapapapapa/HiFiScout/issues/703). The offline contracts and disabled
SQLite storage/scheduler are implemented. Catalog integration and UI are subsequent changes.

## Review recorded 2026-09-22

Baseline: main `419360658b04fcf0076fc674d13f37a76c8fe0ee` (e-earphone was added, disabled,
after the original design). Existing shop data and search still belong to D1; per-shop DOs
coordinate crawling. This foundation neither migrates that storage nor registers another shop.
Follow [adding shops](adding-shops.md) and [crawl orchestration](crawl-orchestration.md) for shared
parsing, URL, pacing and quiet-hour boundaries. Auction prices must not enter `SellerProduct.priceYen`
or the existing retail price/history projections.

During this implementation, [#706](https://github.com/apaapapapapa/HiFiScout/pull/706) advanced main
to `2ea9bc2a3e45f102856bfbd311d24f5feb53545a` and enabled e-earphone after that seller's consent was
confirmed. That independent authorization does **not** satisfy any Yahoo acquisition/redistribution
gate. Preserve the concurrent shop change; Yahoo remains disabled and unverified.

### Acquisition and redistribution gate

The following official references were retrieved on 2026-09-22. Search/page caches are not proof
of the current raw HTML contract or a grant of access. No seller inventory was crawled by CI.

| Evidence | Finding / remaining action |
| --- | --- |
| [Old API retirement](https://developer.yahoo.co.jp/changelog/2018-02-20-auction160.html) | The old public Auction Web API ended on 2018-02-22. Do not use the obsolete endpoint or assume a replacement. No contract/feed usable by HiFiScout was established in this review. |
| [LINE Yahoo common terms](https://www.lycorp.co.jp/ja/company/terms/) | Sections 8.3 and 14 restrict uses beyond the intended service purpose. Public visibility is not permission for collection/redistribution. |
| [Auction guidelines](https://auctions.yahoo.co.jp/special/html/guidelines.html) | Section 6(2) restricts collecting/using other users' posted content beyond transaction needs. Section 1 mentions partner publication; it does not establish HiFiScout as an authorized partner. Obtain and record an applicable permission/contract before enabling. |
| [robots.txt](https://auctions.yahoo.co.jp/robots.txt) | The research fetch failed without usable content. This is **unknown**, not an empty/allow policy or a confirmed seller HTTP status. Fetch and evaluate the actual user-agent/path policy before launch. Robots permission is separate from redistribution permission. |
| Account telemetry | No connected Cloudflare reader was available in this session. Account plan, DO usage and remaining shared headroom were not measured. Do not mark an allocation or free-tier fit as verified. |
| Raw source contract | Current seller HTML/authorized feed fixture has not been established. Synthetic regressions cannot satisfy this launch gate. |

The gates in `src/auctions/yahoo/policy.ts` stay `unverified`. Approval needs dated evidence,
authorization scope, allowed fields/paths, review owner and recheck conditions recorded here and
reviewed in a PR. Do not put private contracts, seller personal data or credentials in this public file.
No permission request, agreement, paid-plan change or production mutation was made by this review.

## Initial discovery scope

Only these exact buckets are pilot candidates. Category ancestry is provenance, not permission
to discover every descendant. New links, brand buckets and related categories need explicit review.

| Bucket | Verified source hierarchy | HiFiScout hint |
| --- | --- | --- |
| [2084037425](https://auctions.yahoo.co.jp/list3/2084037425-category.html) | Audio 23764 → Amplifiers 23792 → General 2084037425 | None: this contains different amplifier types, kits and accessories. |
| [2084024118](https://auctions.yahoo.co.jp/category/list/2084024118/) | Audio 23764 → CD decks [23772](https://auctions.yahoo.co.jp/category/list/23772/) → General 2084024118 | `SRC.DISC`, corroborative only; never proof of the sold subject. |

The source category remains distinct from the canonical category. Keep unresolved, junk, parts,
empty boxes, compatible accessories and bundles distinct; do not drop or merge them into a main unit.
After measured pilot acceptance, expand to speakers/analog, then headphones/earphones/DAP, then
accessories/parts. This is not a promise of full category coverage at any pilot stage.

Future transport candidates are HTTPS on `auctions.yahoo.co.jp`, exact allowlisted category/list
paths and `/jp/auction/<id>` detail paths. Arbitrary redirects, alternate origins, login/captcha,
credentials and nonstandard ports are outside the candidate contract. Revalidate every redirect.
Use an honest user agent identifying `HiFiScout` and the project; do not spoof a browser or rotate
identity/IP to circumvent restrictions. Actual User-Agent and approved pacing must be recorded
with the grant before transport is wired. Existing global user-agent/pacing/robots infrastructure
must be reused rather than bypassed.

## Provisional resource ceilings, not measured entitlement

[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) retrieved on
2026-09-22 documents Free limits of 100,000 requests/day, 13,000 GB-s/day, 5 million SQLite rows
read/day, 100,000 rows written/day and 5 GB total storage. These are shared account constraints,
not multiplied by creating DOs. Requests include alarms/RPC; storage includes index/FTS work,
KV operations, `setAlarm` writes and deletes. Also account for caller Workers, D1 catalog reads,
R2 evidence and retries. Limits reset at 00:00 UTC (09:00 JST), not local midnight.
See also [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

`YAHOO_AUCTION_PILOT_LIMITS` is the single code definition of proposed ceilings: 2,000 retained
items, 500 new items and 500 seller requests per UTC day (including retries/robots/redirects),
100 listing pages/day, at least 60 seconds between seller requests, 1 MiB responses and 100 items
per page. It proposes 5,000 DO requests, 250,000 rows read, 10,000 rows written, 1,000 GB-s/day and
100 MB stored. These are conservative planning choices, not measurements or permission to fetch.

Reserve 20% of the allocated request/read/write/duration budget for recovery, stopping and bounded
retention. Stop ordinary admissions before that reserve; no operation may exceed the hard ceiling.
Before launch, replace/reduce the proposed allocation using the account's actual plan and recent
complete usage intervals, leaving explicit headroom for existing crawl DOs. Record UTC interval,
namespace/account scope, observation age, missing dimensions and the accepted allocation. Missing,
sampled, quota-deferred or stale evidence is not zero. If usable headroom is unknown, admission
remains disabled. Stage 3 owns persistence, metering and enforcement; these constants alone do not
implement a runtime quota limiter or prove free-tier compliance.

## Independent switches and failure policy

The offline policy accepts `YAHOO_AUCTIONS_COLLECT_ENABLED`, `YAHOO_AUCTIONS_SEARCH_ENABLED` and
`YAHOO_AUCTIONS_DISPLAY_ENABLED`. Only the exact string `true` requests enablement; unset/invalid
values are false. Flags cannot approve collection, redistribution, robots, account budget or the
source contract. Collection requires its acquisition/robots/budget/contract gates; serving requires
redistribution/budget/contract gates. Stopping collection does not inherently disable serving
already authorized stored facts. All three are off with the committed evidence.

These controls are wired to the dedicated DO with disabled deployment defaults. Stage 3 must wire every
scheduled/manual/recovery entry through collection admission, the shared 23:00–08:00 JST quiet
window and durable manual pause. Stage 5 must gate both API and UI independently. No public request
may fetch Yahoo. Unknown source layouts and responses beyond bounds stop parsing, not report an
empty successful inventory. No successful HTML, images, full descriptions, seller profiles or bid
histories should be retained/re-published by this pilot.

401/403/authentication challenges halt for review. 429 backs off and respects `Retry-After`;
repeated throttling halts. Network/5xx errors get bounded exponential retries after normal pacing.
404/410 means unavailable-unconfirmed, not sold or ended. Time expiry means end-check-pending,
not a completed sale. Stage 3 persists attempt caps and backoff state; the offline classification
helper performs no retry itself.

## Required evidence before advancing to live collection

Obtain acquisition/redistribution scope and actual robots policy; validate an authorized current
source fixture; measure account headroom; implement stage-3 bounded storage, pacing and budget
admission; run offline regression/CI and review. Keep unresolved prerequisites unchecked in #703.
A merged foundation or a green source/deployment run is not authorization to start collecting.

## Offline observation contract (step 2)

`src/auctions/types.ts` is separate from retail offers. `YahooAuctionSource.parse(unknown, unknown)`
is exchangeable and performs no I/O, pagination, persistence or registration. The candidate HTML
adapter accepts only bounded `li.Product` cards with one validated `Product__titleLink` and explicit
`dt`/`dd` labels. This is a deliberately narrow **synthetic fixture contract, not verified current
Yahoo markup**. Do not turn on collection based on these tests. Obtain an authorized raw fixture
and adjust/replace the adapter before changing `sourceContract` to verified. Unknown layouts,
empty pages, inert templates, duplicate labels and oversized responses never prove empty inventory.
Parsed pages always have partial coverage; malformed fields/cards retain diagnostics.

Stable item facts are separated from `live` observations. An outer `null` means not observed;
`buyNowPrice: {value: null, observedAt}` specifically means explicitly no instant-buy price.
Updates preserve unobserved live facts and their original timestamps. Current price and instant-buy
price have separate integer-yen/tax fields; shipping is a separate enum, not an assumed zero.
No field represents a hammer price or a confirmed transaction. Multiple amounts or ambiguous tax
values stay unresolved. Titles and revisions remain intact; sold-subject and sale-unit labels are
explicit hints, never canonical product matches. Missing hints remain unknown for the existing
catalog resolver to evaluate in step 4.

The scheduler owns generation/sequence and the original fetch time. The parser validates these
runtime inputs; replay time is never substituted. The pure reducer rejects stale generations,
sequences and timestamps, mismatched source identities and unconfirmed reopening. Missing records
are not reducer inputs. A later explicit start after an observed confirmed end is required to
reopen the same external ID as a new cycle; the old cycle's live facts are not carried forward.
A new external ID is a separate listing. State/outcome are not inferred from transport failures,
prices or bid counts. Expiring an end timestamp derives `end_check_pending` for presentation only;
it does not mutate the observed source state or prove a winner. End extensions are new observations.
Partial field updates never refresh the source state's own freshness timestamp. An explicit second
confirmation of the same terminal state does refresh that state's evidence time.

### Visibility boundary and regression coverage

After the shared raw-text/comment filter, `visible-markup.ts` removes complete explicitly hidden
subtrees before any card, title or labelled field is extracted. It covers hidden ancestors as well
as attributes directly on a card or value: boolean `hidden`, `aria-hidden=true` and explicit inline
`display:none` / `visibility:hidden`. Attribute scanning respects quoted `>` characters and void
elements; CSS comments and HTML character references do not hide those explicit declarations.
Structural placeholders prevent removed labels from pairing with an unrelated neighboring value.
Unterminated hidden subtrees or quoted attributes reject the candidate layout rather than exposing
unknown fallback content. This is a conservative bounded filter, **not an HTML5/CSS renderer**;
external stylesheets, media queries and browser-repaired malformed structures are not established
by this contract. Validate actual source visibility under the source-contract gate before enabling.

The offline suite contains the policy tests, 16 observation/parser cases, two self-review regressions
and five visibility/calendar cases. The latter reproduce the hidden-ancestor review finding, protect
against inherited object-property labels, and check the last valid/first invalid day in all 12 months.
Tests use fictional IDs and products. They exercise adjacency, missing/explicitly absent facts,
hidden raw markup, unknown layouts, zero bids, tax/shipping, sale units/subjects, price changes,
extensions, stale/replayed observations and confirmed versus scheduled ends. They make no seller
requests and establish neither production parser compatibility nor actual Cloudflare costs.

## Public offer boundary

The canonical observation, reducer and parser above remain the only internal model. The explicit
`AuctionOffer` in `src/api/auction-contracts.ts` does not inherit observations or retained item facts.
`src/auctions/public-offer.ts` copies approved public fields and normalized catalog identity at each
nesting level; seller titles, raw manufacturer/model/category/condition text, internal stamps and
extra runtime properties do not enter public responses. Future routes must use this mapper after
source validation and the existing serving admission gates. No route is activated by this contract.

The public buy-now union preserves all three existing source meanings: `set` carries the price,
tax evidence and its observation time; `none` carries the explicit absence's observation time;
`unknown` carries no invented value or timestamp. Current and buy-now price evidence remain
independent, including after partial rechecks. Public reads do not replace their times with now or
with the latest unrelated observation, and they do not calculate guessed tax/fee-inclusive prices.

Presentation checks the current clock, snapshot time and source-state evidence time before deriving
any phase. Invalid times or future evidence yield unknown phase/freshness, including for ended and
unavailable states. Saved source facts remain untouched. The existing freshness threshold, expiry,
confirmed-ending and relisting rules continue to use the canonical reducer/presentation helpers.

## SQLite runtime implementation (step 3, disabled deployment)

The `YahooAuctions` SQLite DO uses the stable name `yahoo-auctions-v1`; the existing crawl/admin
namespaces are unchanged. Its version table rejects a newer schema rather than mutating it on an
older Worker. New deploy vars for collection, search and display are all `false`. The reviewed
source/robots/permission/account gates remain unverified. No scheduled dispatch or public route
is introduced by the storage PR; there is no production acquisition during this rollout.

`auction_items` and its trigram FTS index change only for changed item facts. Live prices/state
have a separate table and indexes; an identical observation stamp performs zero SQL writes.
A fresh confirmation keeps its actual observation timestamp and pays the live-state write.
Receipts, task cursors and observations commit in one synchronous storage transaction. All SQL
cursors are consumed before `await`; cursor rowsRead/rowsWritten are collected after consumption.

The scheduler reserves an upper bound before the request and persists its generation/sequence,
attempt and next eligible time. It arms a recovery wake before I/O. A failed commit retries with a
new charged permit, while a committed page advances the cursor and prevents immediate refetch.
Pause increments the generation, fencing delayed responses. Resume preserves backoff, source halt
and UTC-day charges. Ready discovery/confirmation classes alternate. Discovery overlaps three
20-item pages every cycle; coverage stays partial. Confirmation uses one hour, shortened to thirty
minutes near/past the planned end. Eight successful-but-unconfirmed past-end checks stop that task.
Four transport failures stop a task; `retry_failed` explicitly resets at most twenty tasks without
resetting the shared budget or source halt. `wake` repairs missing Alarms without fetching directly.
Discovery's soft-budget exhaustion defers that task to the next UTC day, preserving confirmation
work in the recovery reserve. Normal status/resume controls stop at the soft ceiling; bounded
`pause` and `public_pause` controls may use the reserve. Hard exhaustion still requires the
deployment switches, and a rejected Alarm retains its single next-day recovery wake.

Robots is its own paced/charged request with a maximum 64 KiB body. One external HTTP request uses
one permit; redirects and authentication challenges stop for review. Existing robots parsing and
bounded response decoding are reused. The candidate listing/detail adapter still requires an
**authorized real fixture**; a synthetic parser pass does not approve its live URL/markup contract.
Unknown layouts stop the scheduler. No HTML response is persisted. Retry-After is honored; repeated
429s, authentication failures, or delays exceeding thirty days halt for review.

Retention deletes at most twenty records, receipts and expired candidate-cache entries per successful
scheduler turn. The retained-item cap is 2,000; exceeding it cannot create unbounded confirmation
tasks. Collection and public-serving pauses are separate durable fields, both initially paused.
The deployment switches remain the emergency stop if storage/quota prevents a management write.
Rollback must keep this namespace/class export and set the switches false; do not delete its data or
rename the namespace. A newer schema requires a forward-compatible Worker, not destructive rollback.

SQL family measurements are emitted as `auction_sql_usage`, tagged with the Worker **version ID**,
not mislabeled as a Git SHA. SQL writes include index/FTS effects reported by workerd. The runtime
budgets are conservative reservations, not actual account billing. Invocation admission reserves the
DO request; seller permits separately reserve HTTP requests, commit/retention rows and wall-duration
headroom. Failed reservations do not restore earlier consumption. CPU and billed duration remain
null until platform telemetry is available. KV/Alarm billing and account-wide headroom still require
platform reconciliation before collection is approved. The 100 MB database ceiling includes indexes.

The executable `auction-storage` harness contract runs `test/auction-runtime.test.ts` in real
workerd SQLite, covering rollback, replays, 2,000-item capacity/unrelated growth, live-only writes,
Japanese trigram, UTC reset, pause/resume, quiet hours, Retry-After and receipt/cursor recovery.
These outcomes are local runtime evidence, not production cost or data-quality measurements.
