# HiFiScout

HiFiScout is a non-official cross-shop search application for used audio equipment. The current collectors target **Audio Union**, **逸品館**, **フジヤエービック**, **ハイファイ堂**, and **FOR MUSIC**.

> The application is deployed on Cloudflare, but broad public release should wait until each collector and the applicable site terms have been re-checked.

## Design principles

- Store only factual listing data needed for search: shop, manufacturer, model/title, category, condition grade, price, stock state, source URL, and observation timestamps.
- Do **not** store or republish shop product images, descriptions, staff comments, or logos.
- Always link users to the seller's original product page.
- User traffic never causes seller-site crawling. A Cloudflare Cron Trigger starts every 5 minutes and selects at most one due shop per tick.
- Check `robots.txt` before crawling, back off on failures, and never bypass authentication, CAPTCHA, or other access controls.
- Price history starts when HiFiScout observes a listing; no historical seller database is copied.
- Every shop has an environment-level kill switch and request-delay override so collection can be stopped or slowed without changing crawler code.

## Architecture

```text
Browser
  │
  ├── static UI (Cloudflare Workers Static Assets)
  │
  └── /api/*
          │
       Worker ─────────────── D1
          │                   ├─ products
          │                   ├─ price_history
          │                   └─ crawl state
          │
   Cron */5 minutes
          │
          ├─ Audio Union collector
          ├─ 逸品館 collector
          ├─ フジヤエービック collector
          ├─ ハイファイ堂 collector (Browser Run)
          └─ FOR MUSIC collector
```

## Crawl controls

The cron wakes every five minutes, but each collector has its own interval, enabled flag, and request delay. Defaults are 30 minutes. Audio Union deliberately uses a longer 10-second request delay.

```jsonc
"vars": {
  "AUDIOUNION_ENABLED": "true",
  "IPPINKAN_ENABLED": "true",
  "FUJIYA_AVIC_ENABLED": "true",
  "HIFIDO_ENABLED": "true",
  "FORMUSIC_ENABLED": "true",

  "AUDIOUNION_INTERVAL_MINUTES": "30",
  "IPPINKAN_INTERVAL_MINUTES": "30",
  "FUJIYA_AVIC_INTERVAL_MINUTES": "30",
  "HIFIDO_INTERVAL_MINUTES": "30",
  "FORMUSIC_INTERVAL_MINUTES": "30",

  "AUDIOUNION_REQUEST_DELAY_MS": "10000",
  "IPPINKAN_REQUEST_DELAY_MS": "1200",
  "FUJIYA_AVIC_REQUEST_DELAY_MS": "1200",
  "HIFIDO_REQUEST_DELAY_MS": "1200",
  "FORMUSIC_REQUEST_DELAY_MS": "1200",

  "FUJIYA_AVIC_MAX_PAGES": "50",
  "HIFIDO_MAX_PAGES": "3",
  "HIFIDO_RECHECK_MAX_PAGE": "120",

  "CRAWL_MIN_ITEM_RATIO": "0.5",
  "CRAWL_MIN_ITEM_BASELINE": "20",
  "SYNC_HEALTH_WARNING_FACTOR": "2",
  "SYNC_HEALTH_CRITICAL_FACTOR": "6"
}
```

Set `<SHOP>_ENABLED=false` to stop a collector immediately on the next deployment. `FUJIYA_AVIC_MAX_PAGES` is a safety ceiling.

### Item-count safety guard

For crawls that can deactivate missing products, HiFiScout compares the parsed item count with the last successful run. Once the previous successful run had at least 20 items, a drop below 50% is treated as suspicious. The run fails before product updates or mass deactivation, the previous baseline remains intact, and the normal exponential backoff applies.

The same anomaly guard is enabled for Hifido because its fixed recent-page window should have relatively stable cardinality. Volatile feeds such as Audio Union's new-arrival page are not subjected to this guard unless they can deactivate missing inventory.

### Hifido stale-data mitigation

Hifido is intentionally **not** fully synchronized every 30 minutes. Each scheduled Hifido crawl fetches:

1. The most recent three 30-item pages.
2. One additional older page selected on a deterministic rotation, currently across pages 4 through 120.

This adds only one Browser Run page per scheduled Hifido crawl while periodically revisiting older observed listings. Hifido is explicitly marked as partial coverage, so a missing item in one of these partial windows never causes unrelated existing products to be deactivated.

## Sync health

`GET /api/health` checks collector freshness rather than returning liveness only.

- `healthy`: last successful crawl is within 2× the shop interval and there are no recent failures.
- `warning`: at least one recent failure, no successful crawl yet, or the last success is older than 2× the interval.
- `critical`: at least 3 consecutive failures or the last success is older than 6× the interval.
- `disabled`: the shop kill switch is off; disabled shops do not make overall health unhealthy.

The health endpoint returns HTTP `503` when the overall state is `critical`. Scheduled runs also emit structured `sync_health_warning` / `sync_health_critical` records to Cloudflare Workers Observability.

## Local setup

Requires Node.js 22+.

```bash
npm install
npm run db:migrate:local
npm run dev
```

To test the scheduled handler locally:

```bash
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

Tests:

```bash
npm test
```

## API

- `GET /api/products` — search/filter/sort active listings.
- `GET /api/meta` — shops, configured intervals, enabled state, sync status/health, manufacturers, categories.
- `GET /api/products/:id/history` — observed price history.
- `GET /api/health` — crawler-aware health endpoint; returns 503 on critical sync health.
- `POST /api/admin/crawl?shop=<shop-key>` — force one collector; requires `Authorization: Bearer <ADMIN_TOKEN>`. A disabled collector stays disabled even for this endpoint.

Query parameters for `/api/products`: `q`, `shop`, `manufacturer`, `category`, `minPrice`, `maxPrice`, `inStock=true`, `sort=newest|updated|priceAsc|priceDesc`, `limit`.

## Collector status

The adapter boundary is isolated under `src/crawler/shops/` because seller HTML changes independently. The following was re-validated against public listing structures on 2026-08-11.

- **逸品館**: uses the official all-used listing and its pagination. Listing markers such as `『展示機』` are kept only as condition metadata and removed from the normalized model name.
- **フジヤエービック**: covers the current used roots for earphones, DAP/headphone amps, headphones, amp/speaker/player products, and DJ/DTM. Pagination is derived from the displayed result counts.
- **ハイファイ堂**: uses Cloudflare Browser Run, reads the latest pages plus one rotating older page, and extracts product ID, manufacturer, model/title, price, category, stock state, and source URL only. `売約済/売約済み` is sold out; ambiguous states such as `予約中` and `商談中` remain `unknown`.
- **FOR MUSIC**: parses the storefront's structured product rows. Clearly marked `中古`, `展示現品`, and `委託品` are collected; explicitly new stock is excluded. `商談中` remains `unknown`, and `売約済` is retained as `sold_out`. Music/book entries are excluded from HiFiScout's equipment inventory.
- **Audio Union**: uses the official new-arrival used listing configured by `AUDIOUNION_ENTRY_URL`, with a default 10-second per-request delay and an independent kill switch.

If a live page can no longer be parsed, the crawler refuses to mark existing products inactive. Partial/dynamically truncated crawls also do not deactivate missing products.

## Before broad public release

1. Re-check robots.txt and current terms for all target shops.
2. Validate each adapter against live HTML from Cloudflare's runtime.
3. Keep crawl intervals conservative and shop-specific; the initial value is 30 minutes.
4. Keep an identifiable crawler User-Agent/contact route.
5. Keep the non-affiliation notice and provide a listing-removal contact path.
6. Review Workers Observability and `/api/health` regularly for parser failures or stale shops.

## Deployment

`main` is deployed by `.github/workflows/deploy.yml` using `CLOUDFLARE_API_TOKEN`. Wrangler applies backward-compatible D1 migrations before deploying the Worker/static assets. The production custom domain is managed in Cloudflare separately from the repository configuration.
