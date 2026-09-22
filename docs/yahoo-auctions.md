# Yahoo! Auctions: gated audio pilot

Status: offline implementation; collection and public serving are **not approved or enabled**.
Issue: [#703](https://github.com/apaapapapapa/HiFiScout/issues/703). The parser, SQLite scheduler,
catalog integration, listing search, independent product-detail section and Access-protected
management controls are implemented. Live acquisition, capacity and quality acceptance remain open.

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
with the grant before transport is enabled. Existing global user-agent/pacing/robots infrastructure
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
100 listing pages/day, at least 60 seconds between seller requests and 1 MiB responses. The parser
rejects more than 100 items; the scheduler requests only 20 per page and overlaps three pages.
Proposals also include 5,000 DO requests, 500 public requests, 5,000 Alarm operations, 250,000 rows
read, 10,000 rows written, 1,000 GB-s/day and 100 MB stored. These are conservative planning choices,
not measurements or permission to fetch. The shared read allowance binds public traffic much earlier
than the independent request allowance; see the search reservation below.

Reserve 20% of the allocated request/read/write/duration budget for recovery, stopping and bounded
retention. Stop ordinary admissions before that reserve; no operation may exceed the hard ceiling.
Before launch, replace/reduce the proposed allocation using the account's actual plan and recent
complete usage intervals, leaving explicit headroom for existing crawl DOs. Record UTC interval,
namespace/account scope, observation age, missing dimensions and the accepted allocation. Missing,
sampled, quota-deferred or stale evidence is not zero. If usable headroom is unknown, admission
remains disabled. The runtime persists conservative reservations and enforces admission, but neither
those reservations nor the local SQL/Alarm counters prove actual account billing or free-tier fit.

## Independent switches and failure policy

The offline policy accepts `YAHOO_AUCTIONS_COLLECT_ENABLED`, `YAHOO_AUCTIONS_SEARCH_ENABLED` and
`YAHOO_AUCTIONS_DISPLAY_ENABLED`. Only the exact string `true` requests enablement; unset/invalid
values are false. Flags cannot approve collection, redistribution, robots, account budget or the
source contract. Collection requires its acquisition/robots/budget/contract gates; serving requires
redistribution/budget/contract gates. Stopping collection does not inherently disable serving
already authorized stored facts. All three are off with the committed evidence.

These controls are wired to the dedicated DO with disabled deployment defaults. Every
scheduled/manual/recovery entry uses collection admission, the shared 23:00–08:00 JST quiet
window and durable manual pause. API and UI are independently gated. No public request
may fetch Yahoo. Unknown source layouts and responses beyond bounds stop parsing, not report an
empty successful inventory. No successful HTML, images, full descriptions, seller profiles or bid
histories should be retained/re-published by this pilot.

401/403/authentication challenges halt for review. 429 backs off and respects `Retry-After`;
repeated throttling halts. Network/5xx errors get bounded exponential retries after normal pacing.
404/410 means unavailable-unconfirmed, not sold or ended. Time expiry means end-check-pending,
not a completed sale. The scheduler persists attempt caps and backoff state; the offline classification
helper performs no retry itself.

## Required evidence before advancing to live collection

Obtain acquisition/redistribution scope and actual robots policy; validate an authorized current
source fixture; measure account headroom; approve the numeric allocation and acceptance plan below;
run offline regression/CI and review. Keep unresolved prerequisites unchecked in #703.
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
extra runtime properties do not enter public responses. The search route uses this mapper after
source validation and the existing serving admission gates. Committed gates keep it disabled.

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
source/robots/permission/account gates remain unverified. Collection uses its own Alarm and public
routes read stored data only; there is no production acquisition during this disabled rollout.

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
null until platform telemetry is available. Alarm get/set/delete attempts are counted separately;
this runtime has no KV get/put/delete calls. These operation counters are not a billing conversion.
Actual Alarm/KV billing and account-wide headroom require platform reconciliation before collection
is approved. The 100 MB database ceiling includes indexes.

The executable `auction-storage` harness contract runs `test/auction-runtime.test.ts` in real
workerd SQLite, covering rollback, replays, 2,000-item capacity/unrelated growth, live-only writes,
Japanese trigram, UTC reset, pause/resume, quiet hours, Retry-After and receipt/cursor recovery.
These outcomes are local runtime evidence, not production cost or data-quality measurements.

## Step 4: shared catalog candidates

The DO uses the existing manufacturer/model resolution and product-identity vetoes. Candidate
sets are keyed by normalized manufacturer/model input; the final identity is computed from each
listing's title, revision/edition, category evidence, subject and unit. Initial linking requires
an explicit main-unit subject and excludes sets. Unknown subjects remain searchable but unmatched.
Title/category accessory evidence still vetoes a contradictory main-unit label. No auction row,
price history, listing projection or unverified product candidate is inserted into D1.

Each maintenance turn registers at most twenty changed item inputs, reads at most twenty due
candidate keys from D1, and replays at most twenty affected listings. Duplicate inputs are collapsed;
price-only updates keep their key and verdict. Queries use the existing catalog/model/alias indexes,
cap candidates and hydration rows, and fence operational manufacturer-alias changes with the existing
registry clock. Oversized/failed lookups do not certify a match. The AI verification clock is not
treated as a complete catalog-change feed.

Candidate snapshots, including empty results, expire after fifteen wall-clock minutes. Their digest
covers current product names/models/verification, manufacturer/alias evidence and categories. The
bounded recheck reads the authoritative tables, so admin, CSV, verification, deletion and merge paths
are covered without requiring every writer to send an event. Only changed keys enqueue a durable
listing cursor; unrelated manufacturer changes do not invalidate every listing. A global
`RESOLUTION_VERSIONS` change invalidates old rule versions on read and replays each refreshed key.

Public readers must require an unexpired candidate snapshot, the current rule version and an exact
listing/cache revision match. Once an update is observed, old links are excluded immediately, even
while the bounded replay is incomplete. During outages or backlog, the fifteen-minute guarantee
expires and the listing becomes unmatched; stale correspondence is never extended by a failed read.
An empty snapshot is retried on expiry, so new catalog additions recover without an inventory sweep.

Catalog work shares the existing Alarm and persisted daily reservations, but performs no seller
request and may run during the collection quiet window. Due maintenance performs one bounded turn,
then yields at least a minute to seller work. Its next checkpoint and Alarm are persisted before D1
I/O; reads time out after fifteen seconds, failures back off thirty minutes, and pause/generation
changes reject late replies. Outer admission and all deployment/permission stops still apply.
Schema version 2 adds candidate keys, revision/cursor and schedule tables. Rollback must retain the
version-2-aware Worker and disable the three switches; a version-1 Worker deliberately rejects it.

The `auction-catalog` load contract measures shared D1 reads for one versus 2,000 duplicate inputs,
and SQLite zero-write replay after a price update. Workerd tests exercise bounded continuation,
negative-cache recovery, revision/expiry exclusion and pause during a delayed lookup. These are
synthetic, local results; live acquisition and public rollout remain blocked by the evidence gates.

## Offline public search and detail (step 5)

`/api/auctions` validates bounded filters before invoking the single stable DO. The DO reads only
stored SQLite data; public requests never query D1 or Yahoo. `/api/auction-features` exposes only
configured serving availability, without a DO lookup. The existing public rate limiter applies;
when it cannot decide, the auction route returns unavailable (there is no permitted edge cache).
Every response is `no-store`, with at most 25 rows plus one lookahead and a 96 KiB payload ceiling.
Current/buy-now price ranges and sorts use separate tax-comparable columns, nulls last and auction
ID ties. There is no exact total count. Filters are conjunctive on the same offer.

FTS5 uses normalized NFKC letters/digits and quoted AND terms, up to four terms of at least three
characters. Short keywords produce an explicit input error; the model filter supports short codes
through an indexed normalized prefix range. Manufacturer/category/catalog filters require a current
catalog candidate revision. Catalog expiry removes confirmed product links even without another
seller observation; expired or unmatched offers remain available through unfiltered search.
Cursors bind all normalized conditions, sort and null position, expire after 15 minutes, and fail
explicitly if invalid or expired. This is a live listing, not an immutable snapshot: price/time
updates can move records across pages. The client deduplicates IDs and offers an explicit new search.

`/auctions` displays current and instant-buy prices separately, known absence versus unknown values,
unit/subject, shipping uncertainty, bid counts including zero, observation time and end-check-pending.
The browser advances its clock without fetching and hides a response after at most 60 seconds (or
earlier catalog expiry); an end time crossing removes the open claim immediately. Returning to a
visible tab also rechecks the clock. Public pause applies on every API read; an already displayed
response expires within this bound. The deployment switch also blocks API access before the DO.

Verified `c-<id>` details request at most eight offers independently. Failure or quota does not replace
the retail detail with an empty list, and auction bids never feed retail minima, history or Price Index.
Cards in the retail results do not fan out auction requests. Source links contain only allowlisted
auction IDs, React escapes all labels, and full seller descriptions/images are not republished.

Public admission reserves 15,100 SQLite reads, 20 writes and 0.25 GB-s per call against the shared
ledger plus its own request dimension. These are conservative bounds, not billing measurements:
with no other work, the current ordinary 200,000-read allocation admits only 13 such reservations,
well before the independent public request ceiling. Do not treat that ceiling as a supported traffic
forecast. The mixed-load regression proves confirmation/stopping can still use the reserved headroom.
Before live enablement, measure actual sorted/filtered workloads, invocation/Alarm/storage costs and
account headroom, then review a sustainable traffic allocation and numeric freshness/p95 criteria.

## Management and recovery

Open **稼働管理 → Yahoo!オークション** (`/#auctions`) in the existing Access-protected admin
Worker. `GET /api/admin/auctions` and bounded JSON `POST /api/admin/auctions/control` use the named
`CatalogAdminService.adminAuctions` RPC. Existing Access, same-origin and body-size guards apply;
the public Worker still returns 404 for `/api/admin/*`. There is no SQL/URL ingestion control.

State loads on first visit and explicit refresh, with no interval polling. The page separates
manual collection pause, public pause, deployment/permission blockers, the nightly window, source
halt, pacing/backoff and daily reservations. Unknown status or platform usage is explicitly unknown,
never a zero. Counts cover the bounded retained database, not the seller's entire inventory.
At 2,000 retained listings, one status request reserves 10,100 reads and one Alarm operation;
refreshing the page repeatedly consumes the same daily read allocation as search and collection.

| Action | Effect and preserved boundary |
| --- | --- |
| Pause collection | Persists pause and advances generation; late fetch/D1 responses cannot commit. Public pause is separate. |
| Pause public serving | Rejects subsequent API reads; already rendered responses expire within 60 seconds. Collection is separate. |
| Save categories | Accepts only the two reviewed buckets; changing the set fences in-flight responses. It does not approve or discover related categories. |
| Resume | Keeps source halt, next-fetch time, Retry-After, UTC charges and the nightly window. It does not override deployment/permission gates. |
| Restore scheduled wake | Re-arms the one saved Alarm when eligible; it does not fetch in the admin HTTP request. |
| Retry exhausted work | Resets at most 20 exhausted task cursors/attempts; shared budget, backoff and source halt remain. |
| Clear reviewed source halt | Requires collection to be paused, collection gates to be approved and an explicit review acknowledgment. Clears halt/throttle streak, advances generation and keeps pause, budgets and backoff; resume is a separate action. |

After every control attempt, including a lost response, reload the persisted state before another
change. If a stop write is rejected by quota/storage failure, disable all three deployment switches
through the normal reviewed deployment flow. Do not retry the failing write indefinitely. Retain
the `YahooAuctions` export, `yahoo-auctions-v1` identity and schema-2-aware code. Roll back exposure
with switches, then forward-fix the implementation; never wipe the namespace or run schema-1 code
against schema 2. Keep the last deployment identity and its public/admin receipts with the incident.

## Numeric pilot evaluation and release sequence

These are **provisional evaluation criteria**, not measured live results or approved capacity.
Before a limited pilot, its owner must record the allowed fields/paths, actual source fixture,
robots review, account plan and headroom, expected public demand and accepted numeric allocation
in a reviewed change. The present 13-search-reservation ceiling is insufficient evidence of useful
public capacity. Do not raise a ceiling merely to meet traffic expectations or pass a test.

| Boundary | Initial criterion and evidence |
| --- | --- |
| Scope | Only the two reviewed buckets; at most 2,000 retained items, 500 new items/day and three overlapping 20-item discovery pages. Coverage remains partial. Record observed discovered/retained/dropped counts and unknown coverage separately. |
| Freshness | Public `open` requires source-state evidence no older than 2 hours; wall time includes the nightly pause. General confirmation interval is 60 minutes and near/past-end interval is 30 minutes. Target p95 successful confirmation age ≤60 minutes during eligible collection time; measure overdue work separately. This is not a 10-minute ending guarantee. |
| End/extension correctness | Every checked extension replaces the scheduled end; time expiry alone produces pending, never sold/ended. Zero false completed-sale claims and zero resurrection from missing pages/errors in the reviewed sample. Record sample size and all unresolved cases. |
| Identity/price correctness | Zero known false product links, retail minimum/history contamination, tax guesses or pair-to-unit conversions in the reviewed sample. Include revisions, compatible accessories, sets, junk, no instant-buy value and zero bids. Unmatched/unknown counts remain visible. |
| Catalog change | Candidate evidence expires within 15 wall-clock minutes, even during outage/backlog. Changed revision excludes the old link immediately; bounded replays must recover within the measured capacity. |
| Public latency/failure | Initial target p95 ≤1 second for the stored-data API at the approved request rate and 2,000-item cap; internal deadline is 2 seconds. Record sample/window, cold starts, p50/p95, timeout/error/quota rates and every configured sort/filter. Quota failure remains unavailable, not an empty successful result. |
| Runtime cost | Preserve executable local ceilings, replay/retention recovery and unrelated-growth checks. Reconcile SQL/index/FTS, requests, Alarm/KV operations, stored bytes, CPU/duration, Workers and D1 totals against actual telemetry. Maintain the accepted ordinary ceiling and 20% recovery reserve in every measured UTC interval. Missing dimensions block a free-tier/capacity claim. |

Deploy the disabled implementation first and verify source CI, the owning `deployment-identity`
and corresponding public/admin `post-deploy-receipt` contents. After the above approvals, separately
review collection enablement for the allowlisted scope. Keep public serving paused while comparing
authorized source observations, task backlog, catalog correctness and account telemetry. The
observation window must cover representative activity, a nightly pause/resume and a UTC budget reset;
record its actual start/end, deployed version and missing coverage rather than inventing a fixed
duration or declaring a short green run conclusive. Stop on authorization/robots/source-contract
failure or exhausted budget and use the recovery procedure above.

Only after those measured criteria and redistribution scope are accepted may a separate reviewed
change enable search/display and release public pause. Re-measure mixed public/collection load at the
approved rate before expanding categories. Preserve the small scope if freshness, load or quality
is unproven. #703 remains open/blocked for live acceptance while these prerequisites are unresolved.
