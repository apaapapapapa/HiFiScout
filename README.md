# HiFiScout

HiFiScout is a non-official cross-shop search application for used audio equipment. The MVP targets **Audio Union**, **逸品館**, **フジヤエービック**, and **ハイファイ堂**.

> This repository prepares the Cloudflare application but does **not** deploy it. Do not publish the service until each collector has been validated against the live site, robots.txt, and the applicable site terms.

## Design principles

- Store only factual listing data needed for search: shop, manufacturer, model/title, category, condition grade, price, stock state, source URL, and observation timestamps.
- Do **not** store or republish shop product images, descriptions, staff comments, or logos.
- Always link users to the seller's original product page.
- User traffic never causes seller-site crawling. A Cloudflare Cron Trigger starts every 5 minutes. It selects at most one due shop per tick, so user traffic never increases seller-site requests and large crawls are not stacked in one Worker invocation.
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
          ├─ Audio Union collector
          ├─ 逸品館 collector
          ├─ フジヤエービック collector
          └─ ハイファイ堂 collector
```

## Per-shop crawl intervals

The cron wakes every five minutes, but each collector has its own interval variable. Defaults are 30 minutes.

```jsonc
"vars": {
  "AUDIOUNION_INTERVAL_MINUTES": "30",
  "IPPINKAN_INTERVAL_MINUTES": "30",
  "FUJIYA_AVIC_INTERVAL_MINUTES": "30",
  "HIFIDO_INTERVAL_MINUTES": "30",
  "AUDIOUNION_ENTRY_URL": ""
}
```

For example, setting Audio Union to 60 and Fujiya Avic to 15 requires only environment configuration; no crawler code change is needed.

## Local setup

Requires Node.js 22+.

```bash
npm install
npx wrangler d1 create hifiscout
```

Put the returned D1 database ID in `wrangler.jsonc`, then:

```bash
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
- `POST /api/admin/crawl?shop=ippinkan` — force one collector; requires `Authorization: Bearer <ADMIN_TOKEN>`.

Query parameters for `/api/products`: `q`, `shop`, `manufacturer`, `category`, `minPrice`, `maxPrice`, `inStock=true`, `sort=newest|updated|priceAsc|priceDesc`, `limit`.

## Collector status

The adapter boundary is intentionally isolated under `src/crawler/shops/` because seller HTML changes independently.

- **逸品館**: initial entry point is the official all-used listing (`/shopbrand/U100000/`) with paginated URLs.
- **フジヤエービック**: initial entry points cover used home audio and used headphones, 50 items per page.
- **ハイファイ堂**: the initial adapter reads the official paginated listing and extracts only product ID, manufacturer, model/title, price, category, stock state, and source URL. It does not retain the listing description or images.
- **Audio Union**: its former `st/new_arrival_used.html` endpoint and current root currently return 404 from external verification. The adapter is implemented but intentionally does not guess or crawl marketplace mirrors. Set `AUDIOUNION_ENTRY_URL` only after the current official/approved source is confirmed. Until then it is skipped rather than treated as a failure.

This fail-closed behavior is deliberate: a site redesign must not erase the local index or trigger aggressive probing.

## Before any public release

1. Re-check robots.txt and current terms for all four shops.
2. Validate each adapter against live HTML from Cloudflare's runtime.
3. Keep crawl intervals conservative and shop-specific; the initial value is 30 minutes.
4. Configure an identifiable User-Agent/contact route before broad use.
5. Add a clear non-affiliation notice and a listing-removal contact path.
6. Obtain explicit permission from Audio Union before public operation if its current terms remain restrictive.

## Deployment

No deployment workflow is included intentionally. When ready to publish, create the D1 database, apply migrations, set secrets/vars, and run `npm run deploy` manually or add an approved deployment workflow.
