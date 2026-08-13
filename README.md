# HiFiScout

HiFiScout is a non-official cross-shop search application for used audio equipment. The current collectors target **Audio Union**, **逸品館**, **フジヤエービック**, **ハイファイ堂**, and **FOR MUSIC**.

> The application is deployed on Cloudflare, but broad public release should wait until each collector and the applicable site terms have been re-checked.

## Design principles

- Store only factual listing data needed for search: shop, manufacturer, model/title, category, condition grade, price, stock state, source URL, and observation timestamps.
- Do **not** store or republish shop product images, descriptions, staff comments, or logos.
- Always link users to the seller's original product page.
- User traffic never causes seller-site crawling. Cron only dispatches due work to Cloudflare Queues.
- Check `robots.txt` before crawling, back off on failures, and never bypass authentication, CAPTCHA, or other access controls.
- Price history starts when HiFiScout observes a listing; no historical seller database is copied.
- Every shop has an environment-level kill switch and request-delay override so collection can be stopped or slowed without changing crawler code.

## Architecture

```text
Browser
  │
  ├── static UI (Cloudflare Workers Static Assets)
  │
  └── /api/* ── Rate Limit API ── Worker ───── D1
                                      │          ├─ products
                                      │          ├─ price_history
                                      │          └─ crawl state
                                      │
Cron */5 minutes ── due-shop dispatcher ── Cloudflare Queue
                                           max concurrency = 1
                                                  │
                                                  ├─ Audio Union collector ── Tokyo Lambda relay
                                                  ├─ 逸品館 collector
                                                  ├─ フジヤエービック collector
                                                  ├─ ハイファイ堂 collector ── Tokyo Lambda relay
                                                  └─ FOR MUSIC collector

Daily retention cron ── bounded D1 cleanup
Weekly GitHub Action ── D1 SQL export ── 90-day artifact
                                      └─ optional R2 copy
```

The queue consumer is globally limited to one concurrent invocation. Scheduled crawls and manually forced crawls use the same queue, so seller crawling cannot overlap accidentally. Cron can enqueue every shop that is due instead of being limited to one shop per five-minute tick.

Audio Union and Hifido use the same allowlisted AWS Lambda relay in `ap-northeast-1` for seller HTTP access. Parsing, normalization, classification, D1 writes, crawl state, and scheduling remain in the Cloudflare Worker. The existing Lambda/workflow names retain `audiounion` for compatibility even though the relay also supports Hifido listing URLs.

## Crawl controls

Each collector has its own interval, enabled flag, and request delay. Shop-plugin fallback intervals are 30 minutes, while the current deployed configuration runs **Audio Union, 逸品館, フジヤエービック, and FOR MUSIC every 60 minutes** and **Hifido every 30 minutes**. Audio Union deliberately uses a longer 10-second request delay.

```jsonc
"vars": {
  "AUDIOUNION_ENABLED": "true",
  "IPPINKAN_ENABLED": "true",
  "FUJIYA_AVIC_ENABLED": "true",
  "HIFIDO_ENABLED": "true",
  "FORMUSIC_ENABLED": "true",

  "AUDIOUNION_INTERVAL_MINUTES": "60",
  "IPPINKAN_INTERVAL_MINUTES": "60",
  "FUJIYA_AVIC_INTERVAL_MINUTES": "60",
  "HIFIDO_INTERVAL_MINUTES": "30",
  "FORMUSIC_INTERVAL_MINUTES": "60",

  "AUDIOUNION_REQUEST_DELAY_MS": "10000",
  "IPPINKAN_REQUEST_DELAY_MS": "1200",
  "FUJIYA_AVIC_REQUEST_DELAY_MS": "1200",
  "HIFIDO_REQUEST_DELAY_MS": "1200",
  "FORMUSIC_REQUEST_DELAY_MS": "1200",

  "AUDIOUNION_INVENTORY_RECHECK_ENABLED": "true",
  "AUDIOUNION_INVENTORY_RECHECK_MIN_AGE_HOURS": "24",
  "AUDIOUNION_INVENTORY_RECHECK_INTERVAL_HOURS": "24",
  "AUDIOUNION_INVENTORY_RECHECK_FAILURE_THRESHOLD": "2",

  "FUJIYA_AVIC_MAX_PAGES": "50",
  "HIFIDO_MAX_PAGES": "3",
  "HIFIDO_RECHECK_MAX_PAGE": "120",

  "CRAWL_MIN_ITEM_RATIO": "0.5",
  "CRAWL_MIN_ITEM_BASELINE": "20",
  "CRAWL_DISPATCH_LEASE_MINUTES": "15",
  "PRODUCT_TOUCH_INTERVAL_MINUTES": "1440",
  "SYNC_HEALTH_WARNING_FACTOR": "2",
  "SYNC_HEALTH_CRITICAL_FACTOR": "6",

  "CRAWL_RUN_RETENTION_DAYS": "30",
  "PRICE_HISTORY_RETENTION_DAYS": "1095",
  "INACTIVE_PRODUCT_RETENTION_DAYS": "365",
  "RETENTION_DELETE_BATCH_SIZE": "500"
}
```

Set `<SHOP>_ENABLED=false` to stop a collector on the next deployment. `FUJIYA_AVIC_MAX_PAGES` is a safety ceiling. The authoritative deployed values live in `wrangler.jsonc`; plugin defaults are fallbacks for missing environment configuration, not the production schedule.

### Queue dispatch and exclusion

The five-minute Cron Trigger finds **all** due shops and sends one message per shop to `hifiscout-crawl`. A 15-minute `queued_at` lease suppresses repeated dispatch while a message is waiting. The queue consumer uses `max_batch_size=1` and `max_concurrency=1`, so only one seller crawl can run at a time. Failed crawl results are recorded using the existing exponential backoff; infrastructure-level queue delivery failures retain the queue's retry/DLQ protection.

`POST /api/admin/crawl` enqueues a forced crawl and returns HTTP `202` instead of running seller requests on the HTTP request path.

### Item-count safety guard

For crawls that can deactivate missing products, HiFiScout compares the parsed item count with the last successful run. Once the previous successful run had at least 20 items, a drop below 50% is treated as suspicious. The run fails before product updates or mass deactivation, the previous baseline remains intact, and the normal exponential backoff applies.

The same anomaly guard is enabled for Hifido because its fixed recent-page window should have relatively stable cardinality. Volatile feeds such as Audio Union's new-arrival page are not subjected to this guard unless they can deactivate missing inventory.

### Hifido stale-data mitigation

Hifido is intentionally **not** fully synchronized every 30 minutes. Each scheduled Hifido crawl fetches:

1. The most recent three 30-item pages.
2. One additional older page selected on a deterministic rotation, currently across pages 4 through 120.

This adds only one additional Tokyo-relay listing request per scheduled Hifido crawl while periodically revisiting older observed listings. Hifido is explicitly marked as partial coverage, so a missing item in one of these partial windows never causes unrelated existing products to be deactivated.

## D1 write control

Unchanged listings are no longer updated on every crawl. HiFiScout writes a product when it is new, its factual listing fields change, it becomes active again, or its low-frequency observation heartbeat is due. The default heartbeat is once every 24 hours.

For complete-snapshot collectors, inactive detection now compares the current observed source-ID set with active source IDs from D1 and only writes the actually missing rows. This trades relatively cheap indexed reads for a substantial reduction in D1 row writes while preserving safe deactivation semantics.

## Sync health

`GET /api/health` checks collector freshness rather than returning liveness only.

- `healthy`: last successful crawl is within 2× the shop interval and there are no recent failures.
- `warning`: at least one recent failure, no successful crawl yet, or the last success is older than 2× the interval.
- `critical`: at least 3 consecutive failures or the last success is older than 6× the interval.
- `disabled`: the shop kill switch is off; disabled shops do not make overall health unhealthy.

The health endpoint returns HTTP `503` when the overall state is `critical`. Queue and scheduled runs also emit structured health records to Cloudflare Workers Observability.

## Retention and backups

A daily maintenance cron performs bounded deletes so cleanup itself cannot become a large D1 write spike. Defaults are:

- crawl execution records: 30 days
- price history: 3 years
- inactive products: 1 year
- at most 500 rows per table per daily cleanup invocation

D1 Time Travel remains the first-line point-in-time recovery mechanism. In addition, `.github/workflows/backup.yml` exports the remote D1 database once per week, compresses the SQL dump, and retains it as a GitHub Actions artifact for 90 days.

For longer external retention, create an R2 bucket and set repository variable `HIFISCOUT_BACKUP_BUCKET` to the bucket name. The same workflow will then copy each compressed backup to `d1/` in that bucket. R2 lifecycle/retention policy should be configured on the bucket according to the desired archival period.

## API protection

Public GET API routes use a Cloudflare Workers Rate Limiting binding as an abuse brake. The current ceiling is 120 requests/minute per anonymous actor and API route bucket. Since HiFiScout has no user accounts, the actor key uses the connecting IP with a deliberately high ceiling to reduce the risk of affecting normal users behind shared networks.

`/api/products` also rejects oversized or malformed search parameters before querying D1. Search text is limited to 100 characters, cursor values to 1024 characters, and sort/numeric parameters are validated against the supported format.

## Local setup

Requires Node.js 22+.

```bash
npm install
npm run db:migrate:local
npm run build:frontend
npm run dev
```

The application is TypeScript-only; see `docs/typescript.md`. `public/app.js`, `public/catalog-url-state.js`, and
`public/shop-links.js` are build output produced from `frontend/*.ts` by `npm run build:frontend`, so run it before
`npm run dev` (and after changing any browser source).

To test the crawl dispatcher locally:

```bash
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

Tests:

```bash
npm test
```

Type checking:

```bash
npm run typecheck
```

See `docs/testing-strategy.md` for the test pyramid and the minimal deployed-environment Playwright E2E policy.

## Releases

Releases are automated by Semantic Release on pushes to `main`. The first release workflow run bootstraps the existing `package.json` version as the baseline tag (currently `v0.1.0`), so adopting Semantic Release does not implicitly promote the application to `v1.0.0`.

Use Conventional Commit prefixes for changes that should affect the version:

- `feat:` → minor release
- `fix:` → patch release
- `security:`, `perf:`, `refactor:` → patch release
- `BREAKING CHANGE:` in the commit footer → major release
- `docs:`, `test:`, `chore:`, `ci:` → no release by default

Semantic Release creates the `v<version>` Git tag and GitHub Release notes. HiFiScout is a private npm package (`private: true`), so the release workflow does not publish anything to npm and does not rewrite `package.json` on each release.

## API

- `GET /api/products` — search/filter/sort active listings.
- `GET /api/meta` — shops, configured intervals, enabled state, sync status/health, manufacturers, categories.
- `GET /api/products/:id/history` — observed price history.
- `GET /api/health` — crawler-aware health endpoint; returns 503 on critical sync health.
- `POST /api/admin/crawl?shop=<shop-key>` — enqueue one forced collector run; requires `Authorization: Bearer <ADMIN_TOKEN>` and returns 202. A disabled collector stays disabled.

Query parameters for `/api/products`: `q`, `shop`, `manufacturer`, `category`, `minPrice`, `maxPrice`, `inStock=true`, `sort=newest|updated|priceAsc|priceDesc`, `limit`.

## Collector status

The adapter boundary is isolated under `src/crawler/shops/` because seller HTML changes independently. The following reflects the collector structures in `main` as of 2026-08-11.

- **逸品館**: uses the official all-used listing and its pagination. Listing markers such as `『展示機』` are kept only as condition metadata and removed from the normalized model name.
- **フジヤエービック**: uses the official new-arrival used listing at `/shop/e/ea-usednw_s1/` as its entry point. Additional pages are discovered from the displayed result count and fetched with the site's 50-item pagination. Broad merchandising buckets such as DAP/headphone-amp are treated as corroborative evidence, with bounded detail-page enrichment for unresolved classification.
- **ハイファイ堂**: uses the Tokyo Lambda relay, reads the latest three pages plus one rotating older page, and extracts product ID, manufacturer, model/title, price, category, stock state, and source URL only. `売約済/売約済み` is sold out; ambiguous states such as `予約中` and `商談中` remain `unknown`.
- **FOR MUSIC**: parses the storefront's structured product rows. Clearly marked `中古`, `展示現品`, and `委託品` are collected; explicitly new stock is excluded. `商談中` remains `unknown`, and `売約済` is retained as `sold_out`. Music/book entries are excluded from HiFiScout's equipment inventory.
- **Audio Union**: uses the official new-arrival used listing configured by `AUDIOUNION_ENTRY_URL` through the Tokyo Lambda relay, with a default 10-second per-request delay and an independent kill switch. Low-frequency detail-page checks are used only for stale inventory verification.

If a live page can no longer be parsed, the crawler refuses to mark existing products inactive. Partial/dynamically truncated crawls also do not deactivate missing products.

## Before broad public release

1. Re-check robots.txt and current terms for all target shops.
2. Validate each adapter against live HTML from the actual configured transport/runtime.
3. Keep crawl intervals conservative and shop-specific; the current deployed schedule is 60 minutes for Audio Union/逸品館/フジヤエービック/FOR MUSIC and 30 minutes for Hifido.
4. Keep an identifiable crawler User-Agent/contact route.
5. Keep the non-affiliation notice and provide a listing-removal contact path.
6. Review Workers Observability and `/api/health` regularly for parser failures or stale shops.
7. Configure R2 backup retention if archive history beyond the 90-day GitHub artifact window is required.

## Deployment

`main` is deployed by `.github/workflows/deploy.yml` using `CLOUDFLARE_API_TOKEN`. Wrangler applies backward-compatible D1 migrations before deploying the Worker/static assets. Queue resources are provisioned/bound through Wrangler configuration. Production uses the Worker `workers.dev` endpoint, with the tracked default base URL in `.github/config/production.env`; the optional GitHub repository variable `PRODUCTION_BASE_URL` overrides that value without code changes. E2E uses the same production URL unless `E2E_BASE_URL` or a manual `base_url` input is provided.
