import { Fragment } from "react";

import { isLegacyFavoriteKey } from "./favorites.js";
import { dateFmt, yen } from "./format.js";
import { activityData, priceDropped } from "./product-activity.js";
import {
  SHOP_LISTING_URLS,
  categoryOptionModel,
  offerAvailability,
  offerAvailabilityClass,
  priceSummary,
  safeExternalUrl,
  stockLabel,
  syncShopPresentations,
} from "./product-presentation.js";
import type { MetaResponse } from "../src/api/contracts.js";
import type {
  DisplayOffer,
  DisplayProduct,
  PriceHistoryEntry,
  ProductDetailResponse,
  ProductHistoryResponse,
} from "./types.js";

interface CategoryOptionsProps {
  meta: MetaResponse | null;
}

export function CategoryOptions({ meta }: CategoryOptionsProps) {
  if (!meta) return null;
  const model = categoryOptionModel(meta);
  if (model.legacy.length) {
    return (
      <>
        {model.legacy.map((value) => (
          <option key={value}>{value}</option>
        ))}
      </>
    );
  }
  let separator = 0;
  return (
    <>
      {model.topLevel.map((entry) =>
        entry === "separator" ? (
          <option key={`separator-${separator++}`} disabled data-category-separator="true">
            ────────────
          </option>
        ) : (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ),
      )}
      {model.groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.values.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

export function SyncShopRows({ meta }: { meta: MetaResponse | null }) {
  if (!meta) return null;
  return (
    <>
      {syncShopPresentations(meta.shops || []).map((shop) => (
        <div key={shop.key} className={`sync-shop-row ${shop.status}`}>
          <span className="sync-shop-name">{shop.name}</span>
          <span className="sync-shop-health">{shop.label}</span>
          <time title={shop.exact}>{shop.relative}</time>
        </div>
      ))}
    </>
  );
}

interface ProductCardProps {
  product: DisplayProduct;
  favorite: boolean;
  shopName: (shopKey: string) => string;
  onManufacturer: (manufacturer: string) => void;
  onFavorite: (key: string) => void;
  onOffers: (key: string) => void;
  now?: number;
}

function ShopChip({
  product,
  shopName,
}: {
  product: DisplayProduct;
  shopName: (shopKey: string) => string;
}) {
  if (product.shop_count > 1) {
    return <span className="shop shop-multiple">{product.shop_count}店舗</span>;
  }
  const shopKey = product.representative_offer?.shop_key || "";
  const label = shopKey ? shopName(shopKey) : "ショップ不明";
  const listingUrl = SHOP_LISTING_URLS[shopKey];
  if (listingUrl) {
    return (
      <a
        className={`shop shop-${shopKey} shop-new-arrivals-link`}
        href={listingUrl}
        target="_blank"
        rel="noopener noreferrer"
        title="販売店の新着・中古一覧を開く"
        aria-label={`${label}の新着・中古一覧を開く`}
      >
        {label}
      </a>
    );
  }
  return <span className={`shop shop-${shopKey}`}>{label}</span>;
}

export function ProductCard({
  product,
  favorite,
  shopName,
  onManufacturer,
  onFavorite,
  onOffers,
  now = Date.now(),
}: ProductCardProps) {
  const activity = activityData(product, now);
  const title = product.model || product.representative_offer?.title || "商品名不明";
  const multiOffer = product.offer_count > 1;
  const sourceUrl = safeExternalUrl(product.representative_offer?.source_url);
  const condition = multiOffer ? "" : product.representative_offer?.condition_text || "";
  const favoriteLabel = favorite ? "お気に入りから削除" : "お気に入りに追加";
  const hasServerDetail = !isLegacyFavoriteKey(product.key);
  const updated = activity.activity
    ? `${activity.label} ${dateFmt.format(activity.activity)}`
    : "更新日時不明";
  const manufacturer = product.manufacturer || "メーカー不明";

  return (
    <article className="card" data-key={product.key}>
      <div className="product-summary">
        <div className="card-top">
          <ShopChip product={product} shopName={shopName} />
          <div className="badges">
            {activity.isNew ? (
              <span className="badge">NEW</span>
            ) : activity.isRecentlyUpdated ? (
              <span className="badge">UPDATED</span>
            ) : null}
            {priceDropped(product) ? <span className="badge">PRICE DOWN</span> : null}
            {product.identity_kind === "catalog" && product.shop_count > 1 ? (
              <span className="badge badge-compare">比較</span>
            ) : null}
          </div>
        </div>
        <p className="maker">
          {manufacturer === "メーカー不明" ? (
            manufacturer
          ) : (
            <button
              type="button"
              className="manufacturer-filter-link"
              data-manufacturer-filter={manufacturer}
              title={`${manufacturer}の商品に絞り込む`}
              aria-label={`${manufacturer}の商品に絞り込む`}
              onClick={() => onManufacturer(manufacturer)}
            >
              {manufacturer}
            </button>
          )}
        </p>
        <h2>
          {multiOffer ? (
            <button
              type="button"
              className="product-title-link"
              data-offers={product.key}
              onClick={() => onOffers(product.key)}
            >
              {title}
            </button>
          ) : (
            <a
              className="product-title-link"
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {title}
            </a>
          )}
        </h2>
        <div className="product-submeta">
          <span className="category">{product.category || "カテゴリ不明"}</span>
          {condition ? <span className="condition">{condition}</span> : null}
        </div>
      </div>
      <div className="product-commerce">
        <div className="price-row">
          <strong>{priceSummary(product)}</strong>
        </div>
        <div className={`stock ${offerAvailabilityClass(product)}`}>
          {offerAvailability(product)}
        </div>
        <p className="updated">{updated}</p>
      </div>
      <div className="actions">
        <button
          className="fav"
          data-fav={product.key}
          type="button"
          aria-label={favoriteLabel}
          aria-pressed={favorite}
          onClick={() => onFavorite(product.key)}
        >
          {favorite ? "★" : "☆"}
        </button>
        {hasServerDetail ? (
          <button
            className="offers-button"
            data-offers={product.key}
            type="button"
            onClick={() => onOffers(product.key)}
          >
            {multiOffer ? `${product.offer_count}件の在庫を比較` : "商品詳細"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function LegacyFavoritesNotice({ count }: { count: number }) {
  if (!count) return null;
  return (
    <div className="legacy-favorites-note">
      旧形式で保存されたお気に入りが{count}
      件あります。商品情報が保存されていないため表示できません。
    </div>
  );
}

export function EmptyProducts({
  favoriteMode,
  hasFavorites,
  onClear,
}: {
  favoriteMode: boolean;
  hasFavorites: boolean;
  onClear: () => void;
}) {
  if (favoriteMode && !hasFavorites) {
    return (
      <div className="empty">
        <strong>お気に入りはまだありません。</strong>
        <span>商品一覧の☆からこの端末に保存できます。</span>
      </div>
    );
  }
  return (
    <div className="empty">
      <strong>条件に一致する商品はありません。</strong>
      <button type="button" data-clear-all onClick={onClear}>
        条件をすべて解除
      </button>
    </div>
  );
}

export function ProductError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="empty">
      <strong>{message}</strong>
      <button type="button" data-retry onClick={onRetry}>
        再読み込み
      </button>
    </div>
  );
}

function OfferRow({
  offer,
  shopName,
  onHistory,
}: {
  offer: DisplayOffer;
  shopName: (shopKey: string) => string;
  onHistory: (listingId: number) => void;
}) {
  const dropped =
    offer.previous_price_yen != null &&
    offer.price_yen != null &&
    offer.price_yen < offer.previous_price_yen;
  const price = offer.price_yen == null ? "価格不明" : yen.format(offer.price_yen);
  return (
    <li className="offer">
      <div className="offer-head">
        <span className={`offer-shop shop-${offer.shop_key}`}>{shopName(offer.shop_key)}</span>
        {offer.condition_text ? <span className="condition">{offer.condition_text}</span> : null}
        <span className={`stock ${offer.stock_status}`}>{stockLabel(offer.stock_status)}</span>
      </div>
      <p className="offer-title">{offer.title}</p>
      <div className="offer-commerce">
        <strong>{price}</strong>
        {dropped && offer.previous_price_yen != null ? (
          <del>{yen.format(offer.previous_price_yen)}</del>
        ) : null}
      </div>
      <div className="offer-actions">
        <button
          type="button"
          data-history={offer.listing_product_id}
          onClick={() => onHistory(offer.listing_product_id)}
        >
          価格履歴
        </button>
        <a
          className="shop-link"
          href={safeExternalUrl(offer.source_url)}
          target="_blank"
          rel="noopener noreferrer"
        >
          販売店で確認 ↗
        </a>
      </div>
    </li>
  );
}

export function OffersContent({
  state,
  shopName,
  onHistory,
}: {
  state:
    | { kind: "loading" }
    | { kind: "error" }
    | { kind: "ready"; data: ProductDetailResponse }
    | null;
  shopName: (shopKey: string) => string;
  onHistory: (listingId: number) => void;
}) {
  if (!state) return null;
  if (state.kind === "loading") return <p className="loading-dialog">在庫情報を取得中…</p>;
  if (state.kind === "error")
    return (
      <>
        <h2 id="offers-title">在庫一覧</h2>
        <p>在庫情報を取得できませんでした。</p>
      </>
    );
  const { product, offers } = state.data;
  const heading = product.model || product.representative_offer?.title || "商品";
  return (
    <>
      <p className="maker">{product.manufacturer || "メーカー不明"}</p>
      <h2 id="offers-title">{heading}</h2>
      {product.identity_kind === "catalog" ? (
        <p className="offers-note">
          {product.shop_count}店舗 / {product.offer_count}件の在庫
        </p>
      ) : (
        <p className="offers-note">この商品はまだ他店の在庫と照合できていません。</p>
      )}
      <ol className="offers">
        {offers.length ? (
          offers.map((offer) => (
            <OfferRow
              key={offer.listing_product_id}
              offer={offer}
              shopName={shopName}
              onHistory={onHistory}
            />
          ))
        ) : (
          <li>表示できる在庫がありません。</li>
        )}
      </ol>
    </>
  );
}

export function HistoryContent({
  state,
}: {
  state:
    | { kind: "loading" }
    | { kind: "error" }
    | { kind: "ready"; data: ProductHistoryResponse }
    | null;
}) {
  if (!state) return null;
  if (state.kind === "loading") return <p className="loading-dialog">価格履歴を取得中…</p>;
  if (state.kind === "error")
    return (
      <>
        <h2 id="history-title">価格履歴</h2>
        <p>価格履歴を取得できませんでした。</p>
      </>
    );
  const { product, history } = state.data;
  return (
    <>
      <p className="maker">{product.manufacturer}</p>
      <h2 id="history-title">{product.model || product.title}</h2>
      <ol className="history">
        {history.length ? (
          history.map((entry: PriceHistoryEntry, index) => (
            <Fragment key={`${entry.observed_at}-${index}`}>
              <li>
                <time>{new Date(entry.observed_at).toLocaleString("ja-JP")}</time>
                <strong>{yen.format(entry.price_yen)}</strong>
                {index > 0 && entry.price_yen < history[index - 1].price_yen ? (
                  <span>↓</span>
                ) : null}
              </li>
            </Fragment>
          ))
        ) : (
          <li>履歴はまだありません。</li>
        )}
      </ol>
    </>
  );
}
