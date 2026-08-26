import type { ProductOffer, ProductSearchDetailResponse } from "../api/contracts.js";
import {
  isProductPermalinkRoute,
  productKeyFromPermalinkPath,
  productPermalinkPath,
} from "../api/product-permalink.js";
import { checkPublicApiRateLimit } from "../api-guard.js";
import { SHOP_DEFINITIONS } from "../config.js";
import { productSearchDetail } from "../db/product-search-repository.js";
import { cachedResponse } from "./response.js";

const PERMALINK_CACHE_TTL_SECONDS = 30;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function yen(value: number | null): string {
  return value == null ? "価格情報なし" : `${new Intl.NumberFormat("ja-JP").format(value)}円`;
}

function priceSummary(detail: ProductSearchDetailResponse): string {
  const { lowest_price_yen: low, highest_price_yen: high } = detail.product;
  if (low == null && high == null) return "価格情報なし";
  if (low == null) return yen(high);
  if (high == null || low === high) return yen(low);
  return `${yen(low)}〜${yen(high)}`;
}

function productName(detail: ProductSearchDetailResponse): string {
  const manufacturer = detail.product.manufacturer.trim();
  const model = detail.product.model.trim();
  return [manufacturer, model].filter(Boolean).join(" ") || "商品詳細";
}

function offerHtml(offer: ProductOffer): string {
  const shopName = SHOP_DEFINITIONS[offer.shop_key]?.name || offer.shop_key || "ショップ不明";
  const sourceUrl = safeHttpUrl(offer.source_url);
  const stock = offer.stock_status === "sold_out" ? "売り切れ" : "在庫あり";
  const color = offer.presentation_color ? `<span>${escapeHtml(offer.presentation_color)}</span>` : "";
  const condition = offer.condition_text ? `<span>${escapeHtml(offer.condition_text)}</span>` : "";
  const link = sourceUrl
    ? `<a class="shop-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">販売ページを開く</a>`
    : "";

  return `<li class="permalink-offer">
    <div><strong>${escapeHtml(shopName)}</strong><span>${escapeHtml(stock)}</span></div>
    <p>${escapeHtml(offer.title)}</p>
    <p>${escapeHtml(yen(offer.price_yen))} ${condition} ${color}</p>
    ${link}
  </li>`;
}

export function renderProductPermalinkHtml(
  detail: ProductSearchDetailResponse,
  origin: string,
): string {
  const name = productName(detail);
  const category = detail.product.category || "カテゴリ未設定";
  const canonicalPath = productPermalinkPath(detail.product.key) ?? "/";
  const canonical = new URL(canonicalPath, origin).toString();
  const description = `${name} — ${category}。${detail.product.offer_count}件の出品、${detail.product.in_stock_offer_count}件が在庫あり。${priceSummary(detail)}`;
  const colors = (detail.product.presentation_colors ?? [])
    .map((color) => `<span class="permalink-color">${escapeHtml(color)}</span>`)
    .join("");
  const offers = detail.offers.map(offerHtml).join("\n");

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(name)} | HiFiScout</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="noindex,follow">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="HiFiScout">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:title" content="${escapeHtml(`${name} | HiFiScout`)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapeHtml(`${name} | HiFiScout`)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <link rel="icon" type="image/jpeg" href="/hifiscout-mark.jpg">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/brand.css">
  <style>
    #product-permalink-page{position:fixed;inset:0;z-index:1000;overflow:auto;background:#f7f6f2;padding:24px}
    #product-permalink-page .permalink-shell{max-width:920px;margin:0 auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 12px 40px rgba(0,0,0,.12)}
    #product-permalink-page .permalink-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
    #product-permalink-page .permalink-offers{list-style:none;padding:0;display:grid;gap:12px}
    #product-permalink-page .permalink-offer{border:1px solid #ddd8ce;border-radius:12px;padding:16px}
    #product-permalink-page .permalink-offer>div{display:flex;justify-content:space-between;gap:12px}
    #product-permalink-page .permalink-color{margin-left:8px}
  </style>
</head>
<body>
  <section id="product-permalink-page" data-product-key="${escapeHtml(detail.product.key)}" aria-label="商品詳細">
    <main class="permalink-shell">
      <div class="permalink-head">
        <div>
          <a href="/" aria-label="HiFiScout トップへ">HiFiScout</a>
          <p>${escapeHtml(category)}</p>
          <h1>${escapeHtml(name)}${colors}</h1>
        </div>
        <button type="button" data-permalink-close aria-label="商品詳細を閉じる">×</button>
      </div>
      <p><strong>${escapeHtml(priceSummary(detail))}</strong></p>
      <p>${detail.product.offer_count}件の出品 / ${detail.product.in_stock_offer_count}件が在庫あり</p>
      <h2>ショップ別の出品</h2>
      <ul class="permalink-offers">${offers}</ul>
    </main>
  </section>
  <div id="root"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>`;
}

export function productPermalinkNotFoundResponse(): Response {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,follow"><title>商品が見つかりません | HiFiScout</title><link rel="stylesheet" href="/styles.css"></head><body><main><h1>商品が見つかりません</h1><p>URLが正しくないか、商品が現在のカタログに存在しません。</p><p><a href="/">HiFiScoutの商品一覧へ戻る</a></p></main></body></html>`;
  return new Response(html, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, follow",
    },
  });
}

/** Handles the public permalink namespace; returns `null` for unrelated paths. */
export async function handleProductPermalink(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isProductPermalinkRoute(url.pathname)) return null;

  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET", "cache-control": "no-store" },
    });
  }

  const rate = await checkPublicApiRateLimit(request, env);
  if (!rate.allowed) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "cache-control": "no-store", "retry-after": "60" },
    });
  }

  const key = productKeyFromPermalinkPath(url.pathname);
  if (!key) return productPermalinkNotFoundResponse();

  // Catalog query parameters belong to the SPA state, not to the product document itself.
  const cacheRequest = new Request(new URL(url.pathname, url.origin).toString(), { method: "GET" });
  return cachedResponse(cacheRequest, ctx, async () => {
    const detail = await productSearchDetail(env.DB, key);
    if (!detail) return productPermalinkNotFoundResponse();
    return new Response(renderProductPermalinkHtml(detail, url.origin), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": `public, max-age=${PERMALINK_CACHE_TTL_SECONDS}`,
        "x-robots-tag": "noindex, follow",
      },
    });
  });
}
