# HiFiScout

HiFiScout is a non-official cross-shop search application for used audio equipment. The current collectors target **Audio Union**, **逸品館**, **フジヤエービック**, **ハイファイ堂**, and **FOR MUSIC**.

> The application is deployed on Cloudflare, but broad public release should wait until each collector and the applicable site terms have been re-checked. Audio Union remains fail-closed until a verified official inventory endpoint is configured.

## Design principles

- Store only factual listing data needed for search: shop, manufacturer, model/title, category, condition grade, price, stock state, source URL, and observation timestamps.
- Do **not** store or republish shop product images, descriptions, staff comments, or logos.
- Always link users to the seller's original product page.
- User traffic never causes seller-site crawling. A Cloudflare Cron Trigger starts every 5 minutes and selects at most one due shop per tick.
- Check `robots.txt` before crawling, back off on failures, and never bypass authentication, CAPTCHA, or other access controls.
- Price history starts when HiFiScout observes a listing; no historical seller database is copied.

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
          ├─ Audio Union collector (fail-closed until configured)
          ├─ 逸品館 collector
          ├─ フジヤエービック collector
          ├─ ハイファイ堂 collector
          └─ FOR MUSIC collector
```

## Per-shop crawl intervals

The cron wakes every five minutes, but each collector has its own interval variable. Defaults are 30 minutes.

```jsonc
"vars": {
  "AUDIOUNION_INTERVAL_MINUTES": "30",
  "IPPINKAN_INTERVAL_MINUTES": "30",
  "FUJIYA_AVIC_INTERVAL_MINUTES": "30",
  "FUJIYA_AVIC_MAX_PAGES": "50",
  "HIFIDO_INTERVAL_MINUTES": "30",
  "FORMUSIC_INTERVAL_MINUTES": "30",
  "AUDIOUNION_ENTRY_URL": ""
}
```

`FUJIYA_AVIC_MAX_PAGES` is only a safety ceiling. FOR MUSIC currently exposes the relevant cross-category inventory on a single storefront page, so its collector performs one storefront request per scheduled crawl.

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
- `GET /api/meta` — shops, configured intervals, sync status, manufacturers, categories.
- `GET /api/products/:id/history` — observed price history.
- `GET /api/health` — liveness endpoint.
- `POST /api/admin/crawl?shop=<shop-key>` — force one collector; requires `Authorization: Bearer <ADMIN_TOKEN>`.

Query parameters for `/api/products`: `q`, `shop`, `manufacturer`, `category`, `minPrice`, `maxPrice`, `inStock=true`, `sort=newest|updated|priceAsc|priceDesc`, `limit`.

## Collector status

The adapter boundary is isolated under `src/crawler/shops/` because seller HTML changes independently. The following was re-validated against public listing structures on 2026-08-11.

- **逸品館**: uses the official all-used listing and its pagination. Listing markers such as `『展示機』` are kept only as condition metadata and removed from the normalized model name.
- **フジヤエービック**: covers the current used roots for earphones, DAP/headphone amps, headphones, and amp/speaker/player products. Pagination is derived from the displayed result counts.
- **ハイファイ堂**: extracts product ID, manufacturer, model/title, price, category, stock state, and source URL only. `売約済/売約済み` is sold out; ambiguous states such as `予約中` and `商談中` remain `unknown`.
- **FOR MUSIC**: parses the storefront's structured product rows. Clearly marked `中古`, `展示現品`, and `委託品` are collected; explicitly new stock is excluded. `商談中` remains `unknown`, and `売約済` is retained as `sold_out`. Music/book entries are excluded from HiFiScout's equipment inventory.
- **Audio Union**: remains fail-closed and requires `AUDIOUNION_ENTRY_URL`; marketplace mirrors are not substituted automatically.

If a live page can no longer be parsed, the crawler refuses to mark existing products inactive. Partial/dynamically truncated crawls also do not deactivate missing products.

## Before broad public release

1. Re-check robots.txt and current terms for all target shops.
2. Validate each adapter against live HTML from Cloudflare's runtime.
3. Keep crawl intervals conservative and shop-specific; the initial value is 30 minutes.
4. Keep an identifiable crawler User-Agent/contact route.
5. Keep the non-affiliation notice and provide a listing-removal contact path.
6. Resolve Audio Union permission/endpoint questions before enabling that collector.

## Deployment

`main` is deployed by `.github/workflows/deploy.yml` using `CLOUDFLARE_API_TOKEN`. Wrangler provisions the D1 binding, deploys the Worker/static assets, and then applies remote D1 migrations. The production custom domain is managed in Cloudflare separately from the repository configuration.
