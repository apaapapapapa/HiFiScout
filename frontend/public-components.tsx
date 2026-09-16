import { useId } from "react";

import { isLegacyFavoriteKey } from "./favorites.js";
import { dateFmt, yen } from "./format.js";
import { activityData, priceDropped } from "./product-activity.js";
import { ProductPriceIndexSummary, RelativePriceBadge } from "./price-index-ui.js";
import { ModelRelations } from "./model-relations-ui.js";
import { MarketAnalysis } from "./market-analysis-ui.js";
import { OfferFacts } from "./offer-facts.js";
import { OfferTerms } from "./offer-terms.js";
import { offerTermGroups } from "../src/api/offer-terms-contracts.js";
import { WatchSummary } from "./watch-preferences-ui.js";
import { ManufacturerFilterLink, ProductCategoryLinks } from "./product-filter-links.js";
import type { ProductFilterNavigation } from "./product-filter-links.js";
import type { WatchPreference } from "./watch-preferences.js";
import {
  SHOP_LISTING_URLS,
  categoryOptionModel,
  offerAvailability,
  offerAvailabilityClass,
  priceSummary,
  productColors,
  safeExternalUrl,
  stockLabel,
  syncShopPresentations,
} from "./product-presentation.js";
import type { MetaResponse } from "../src/api/contracts.js";
import type { ProductFilters } from "./filters.js";
import type { FilterRelaxation } from "./public-ui-state.js";
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
  favoriteShopUnconfirmed?: boolean;
  compared?: boolean;
  comparisonFull?: boolean;
  onCompare?: (key: string) => void;
  onWatch?: (key: string) => void;
  watchPreference?: WatchPreference;
  shopName: (shopKey: string) => string;
  filterNavigation?: ProductFilterNavigation;
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
  favoriteShopUnconfirmed = false,
  compared = false,
  comparisonFull = false,
  onCompare,
  onWatch,
  watchPreference,
  shopName,
  filterNavigation,
  onFavorite,
  onOffers,
  now = Date.now(),
}: ProductCardProps) {
  const activity = activityData(product, now);
  const title = product.model || product.representative_offer?.title || "商品名不明";
  const colors = productColors(product);
  const multiOffer = product.offer_count > 1;
  const sourceUrl = safeExternalUrl(product.representative_offer?.source_url);
  const representative = product.representative_offer;
  const representsLowestPrice =
    representative != null && representative.price_yen === product.lowest_price_yen;
  const favoriteLabel = favorite ? "お気に入りから削除" : "お気に入りに追加";
  const hasServerDetail = !isLegacyFavoriteKey(product.key);
  const updated = activity.activity
    ? `${activity.label} ${dateFmt.format(activity.activity)}`
    : "更新日時不明";

  return (
    <article className="card" data-key={product.key}>
      <div className="product-summary">
        <div className="card-top">
          <ShopChip product={product} shopName={shopName} />
          <div className="badges">
            {activity.isNew ? (
              <span className="badge">新着</span>
            ) : activity.isRecentlyUpdated ? (
              <span className="badge">更新</span>
            ) : null}
            {priceDropped(product) ? <span className="badge">値下げ</span> : null}
            <RelativePriceBadge product={product} />
            {product.identity_kind === "catalog" && product.shop_count > 1 ? (
              <span className="badge badge-compare">比較</span>
            ) : null}
          </div>
        </div>
        <p className="maker">
          <ManufacturerFilterLink
            manufacturer={product.manufacturer}
            navigation={filterNavigation}
          />
        </p>
        <h2>
          {hasServerDetail ? (
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
          {/* Beside the name, not inside it: the model is what groups the colours together. */}
          {colors.length ? (
            <span className="product-colors">
              {colors.map((color) => (
                <span className="product-color" key={color}>
                  {color}
                </span>
              ))}
            </span>
          ) : null}
        </h2>
        <div className="product-submeta">
          <ProductCategoryLinks product={product} navigation={filterNavigation} />
        </div>
        {favoriteShopUnconfirmed ? (
          <p className="filter-note">
            選択した店舗の出品は未確認です。お気に入りを再確認してください。
          </p>
        ) : null}
      </div>
      <div className="product-commerce">
        <div className="price-row">
          <strong>{priceSummary(product)}</strong>
        </div>
        <p className="price-condition">
          {product.lowest_price_yen == null ? "出品の状態" : "最安出品の状態"}:{" "}
          {representsLowestPrice ? representative.condition_text || "記載なし" : "詳細で確認"}
        </p>
        {product.representative_offer ? (
          <div className="representative-terms">
            {multiOffer ? (
              <p>
                表示出品: {shopName(product.representative_offer.shop_key)} /{" "}
                {product.representative_offer.price_yen == null
                  ? "価格不明"
                  : yen.format(product.representative_offer.price_yen)}
                {!representsLowestPrice
                  ? ` / 状態: ${product.representative_offer.condition_text || "記載なし"}`
                  : ""}
              </p>
            ) : null}
            <OfferTerms facts={product.representative_offer.offer_facts} compact />
          </div>
        ) : null}
        <div className={`stock ${offerAvailabilityClass(product)}`}>
          {offerAvailability(product)}
        </div>
        <p className="updated">{updated}</p>
        {favorite && watchPreference ? (
          <WatchSummary product={product} preference={watchPreference} />
        ) : null}
      </div>
      <div className="actions">
        {favorite && hasServerDetail && onWatch ? (
          <button type="button" className="offers-button" onClick={() => onWatch(product.key)}>
            希望価格・メモ
          </button>
        ) : null}
        {product.identity_kind === "catalog" && onCompare ? (
          <button
            type="button"
            className="offers-button"
            aria-pressed={compared}
            disabled={!compared && comparisonFull}
            onClick={() => onCompare(product.key)}
          >
            {compared ? "比較から外す" : "製品を比較"}
          </button>
        ) : null}
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
            {multiOffer ? `${product.offer_count}件の出品を比較` : "商品詳細"}
          </button>
        ) : null}
        {!multiOffer ? (
          <a className="shop-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">
            販売店で確認 ↗
          </a>
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
  relaxations = [],
  onRelax,
  onReset,
}: {
  favoriteMode: boolean;
  hasFavorites: boolean;
  onClear: () => void;
  relaxations?: FilterRelaxation[];
  onRelax?: (filters: ProductFilters) => void;
  onReset?: () => void;
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
      {relaxations.length && onRelax ? (
        <>
          <span>条件を一つ緩めて、もう一度探せます。</span>
          <div className="empty-actions">
            {relaxations.map((choice) => (
              <button
                type="button"
                key={choice.id}
                data-relax-filter={choice.id}
                onClick={() => onRelax(choice.filters)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {onReset ? (
        <button type="button" onClick={onReset}>
          初期条件に戻す（在庫あり）
        </button>
      ) : null}
      <button type="button" data-clear-all onClick={onClear}>
        在庫条件を含めてすべて解除
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
        {offer.presentation_color ? (
          <span className="product-color">{offer.presentation_color}</span>
        ) : null}
        {offer.condition_text ? <span className="condition">{offer.condition_text}</span> : null}
        <span className={`stock ${offer.stock_status}`}>{stockLabel(offer.stock_status)}</span>
      </div>
      <p className="offer-title">{offer.title}</p>
      <OfferFacts facts={offer.offer_facts} />
      <p className="offer-updated">
        掲載情報の最終取得:{" "}
        {offer.last_seen_at && Number.isFinite(Date.parse(offer.last_seen_at)) ? (
          <time dateTime={offer.last_seen_at}>
            {new Date(offer.last_seen_at).toLocaleString("ja-JP")}
          </time>
        ) : (
          "日時不明"
        )}
      </p>
      <div className="offer-commerce">
        <strong>{price}</strong>
        {dropped && offer.previous_price_yen != null ? (
          <del>{yen.format(offer.previous_price_yen)}</del>
        ) : null}
      </div>
      <OfferTerms facts={offer.offer_facts} compact />
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
  onRetry,
  shopName,
  onHistory,
  filterNavigation,
}: {
  state:
    | { kind: "loading" }
    | { kind: "error" }
    | { kind: "ready"; data: ProductDetailResponse }
    | null;
  shopName: (shopKey: string) => string;
  onHistory: (listingId: number) => void;
  onRetry?: () => void;
  filterNavigation?: ProductFilterNavigation;
}) {
  if (!state) return null;
  if (state.kind === "loading")
    return (
      <>
        <h2 id="offers-title">商品詳細</h2>
        <p className="loading-dialog" role="status">
          在庫情報を取得中…
        </p>
      </>
    );
  if (state.kind === "error")
    return (
      <>
        <h2 id="offers-title">在庫一覧</h2>
        <p role="alert">在庫情報を取得できませんでした。</p>
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            在庫情報を再読み込み
          </button>
        ) : null}
      </>
    );
  const { product, offers } = state.data;
  const heading = product.model || product.representative_offer?.title || "商品";
  const colors = productColors(product);
  return (
    <>
      <p className="maker">
        <ManufacturerFilterLink manufacturer={product.manufacturer} navigation={filterNavigation} />
      </p>
      <h2 id="offers-title">
        {heading}
        {colors.length ? (
          <span className="product-colors">
            {colors.map((color) => (
              <span className="product-color" key={color}>
                {color}
              </span>
            ))}
          </span>
        ) : null}
      </h2>
      <div className="product-submeta">
        <ProductCategoryLinks product={product} navigation={filterNavigation} />
      </div>
      {product.identity_kind === "catalog" ? (
        <p className="offers-note">
          {`${product.shop_count}店舗 / ${product.offer_count}件の出品（在庫あり ${product.in_stock_offer_count}件・売り切れ ${product.sold_out_offer_count}件・未確認 ${Math.max(0, product.offer_count - product.in_stock_offer_count - product.sold_out_offer_count)}件）`}
        </p>
      ) : (
        <p className="offers-note">この商品はまだ他店の在庫と照合できていません。</p>
      )}
      <p className="filter-note">
        商品詳細には、検索条件にかかわらず売り切れ・在庫未確認を含む出品を表示します。
        {offers.length < product.offer_count
          ? `全${product.offer_count}件のうち${offers.length}件を表示しています。`
          : ""}
      </p>
      {offers.length > 1 ? (
        <div
          className="offer-overview"
          tabIndex={0}
          role="region"
          aria-label="店舗ごとの価格・在庫一覧"
        >
          <table>
            <caption>掲載中の出品を比較</caption>
            <thead>
              <tr>
                <th scope="col">販売店</th>
                <th scope="col">価格</th>
                <th scope="col">状態</th>
                <th scope="col">在庫</th>
                <th scope="col">販売単位・仕様</th>
                <th scope="col">確認先</th>
              </tr>
            </thead>
            <tbody>
              {offers.map((offer) => (
                <tr key={offer.listing_product_id}>
                  <th scope="row">{shopName(offer.shop_key)}</th>
                  <td>{offer.price_yen == null ? "価格不明" : yen.format(offer.price_yen)}</td>
                  <td>{offer.condition_text || "記載なし"}</td>
                  <td>{stockLabel(offer.stock_status)}</td>
                  <td>
                    {offerTermGroups(offer.offer_facts).every((group) =>
                      group.values.every((value) => value === "記載なし"),
                    ) ? (
                      "記載なし"
                    ) : (
                      <OfferTerms facts={offer.offer_facts} compact />
                    )}
                  </td>
                  <td>
                    <a
                      href={`#offer-details-${offer.listing_product_id}`}
                      onClick={(event) => {
                        event.preventDefault();
                        const details = document.getElementById(
                          `offer-details-${offer.listing_product_id}`,
                        );
                        if (!(details instanceof HTMLDetailsElement)) return;
                        details.open = true;
                        details.querySelector("summary")?.focus();
                        details.scrollIntoView({ block: "nearest" });
                      }}
                    >
                      出品詳細
                    </a>
                    <a
                      href={safeExternalUrl(offer.source_url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${shopName(offer.shop_key)}で確認`}
                    >
                      販売店 ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ol className="offers">
        {offers.length ? (
          offers.map((offer) => (
            <li key={offer.listing_product_id} className="offer-item">
              <details
                id={`offer-details-${offer.listing_product_id}`}
                className="offer-details"
                open={offers.length === 1}
              >
                <summary>
                  {shopName(offer.shop_key)} /{" "}
                  {offer.price_yen == null ? "価格不明" : yen.format(offer.price_yen)}
                  {" / "}
                  {offer.condition_text || "状態の記載なし"} / {stockLabel(offer.stock_status)}
                  <span className="offer-reference">出品番号 {offer.listing_product_id}</span>
                </summary>
                <ol className="offer-detail-content">
                  <OfferRow offer={offer} shopName={shopName} onHistory={onHistory} />
                </ol>
              </details>
            </li>
          ))
        ) : (
          <li>表示できる在庫がありません。</li>
        )}
      </ol>
      <p className="filter-note">
        記載なしは「付属しない」「保証がない」「整備歴がない」という意味ではありません。
        店舗独自の外観ランクは共通ランクに換算していません。日付はこの出品情報を取得した記録で、現在の在庫を保証するものではありません。最新の状態は販売店で確認してください。
      </p>
      <ProductPriceIndexSummary product={product} />
      <MarketAnalysis analysis={product.market_analysis} />
      {product.model_relations ? (
        <section aria-label="確認済みの機種の関係">
          <h3>機種の関係・シリーズ</h3>
          <ModelRelations relations={product.model_relations} currentKey={product.key} />
        </section>
      ) : null}
    </>
  );
}

const HISTORY_SPARKLINE_WIDTH = 320;
const HISTORY_SPARKLINE_HEIGHT = 88;
const HISTORY_SPARKLINE_PADDING = 8;

interface HistorySparklinePoint {
  x: number;
  y: number;
}

export interface PriceHistorySparkline {
  path: string;
  points: HistorySparklinePoint[];
  minPrice: number;
  maxPrice: number;
}

export function buildPriceHistorySparkline(
  history: readonly PriceHistoryEntry[],
): PriceHistorySparkline | null {
  if (!history.length) return null;

  const prices = history.map((entry) => entry.price_yen);
  const timestamps = history.map((entry) => Date.parse(entry.observed_at));
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice;
  const innerWidth = HISTORY_SPARKLINE_WIDTH - HISTORY_SPARKLINE_PADDING * 2;
  const innerHeight = HISTORY_SPARKLINE_HEIGHT - HISTORY_SPARKLINE_PADDING * 2;
  const firstTimestamp = timestamps[0] ?? 0;
  const lastTimestamp = timestamps.at(-1) ?? firstTimestamp;
  const timeRange = lastTimestamp - firstTimestamp;
  const canScaleByTime =
    history.length > 1 &&
    timeRange > 0 &&
    timestamps.every((timestamp, index) => {
      const previousTimestamp = timestamps[index - 1];
      return (
        Number.isFinite(timestamp) && (previousTimestamp == null || timestamp >= previousTimestamp)
      );
    });

  const points = history.map((entry, index) => {
    const timestamp = timestamps[index] ?? firstTimestamp;
    const x =
      history.length === 1
        ? HISTORY_SPARKLINE_WIDTH / 2
        : canScaleByTime
          ? HISTORY_SPARKLINE_PADDING + ((timestamp - firstTimestamp) / timeRange) * innerWidth
          : HISTORY_SPARKLINE_PADDING + (innerWidth * index) / (history.length - 1);
    const y =
      priceRange === 0
        ? HISTORY_SPARKLINE_HEIGHT / 2
        : HISTORY_SPARKLINE_PADDING + ((maxPrice - entry.price_yen) / priceRange) * innerHeight;
    return { x, y };
  });

  const [first, ...rest] = points;
  const path = first
    ? rest.reduce((value, point) => `${value} H ${point.x} V ${point.y}`, `M ${first.x} ${first.y}`)
    : "";

  return { path, points, minPrice, maxPrice };
}

function PriceHistorySparkline({ history }: { history: readonly PriceHistoryEntry[] }) {
  const chart = buildPriceHistorySparkline(history);
  const id = useId();
  if (!chart) return null;

  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const latestPrice = history.at(-1)?.price_yen ?? chart.maxPrice;
  const description = `${history.length}件の価格履歴。最安値${yen.format(chart.minPrice)}、最高値${yen.format(chart.maxPrice)}、最新価格${yen.format(latestPrice)}。`;

  return (
    <svg
      className="history-sparkline"
      viewBox={`0 0 ${HISTORY_SPARKLINE_WIDTH} ${HISTORY_SPARKLINE_HEIGHT}`}
      role="img"
      aria-labelledby={`${titleId} ${descriptionId}`}
    >
      <title id={titleId}>価格推移</title>
      <desc id={descriptionId}>{description}</desc>
      {chart.path ? <path className="history-sparkline-line" d={chart.path} /> : null}
      {chart.points.map((point, index) => (
        <circle
          className="history-sparkline-point"
          key={`${history[index].observed_at}-${index}`}
          cx={point.x}
          cy={point.y}
          r="2.5"
        />
      ))}
    </svg>
  );
}

export function HistoryContent({
  state,
  onRetry,
}: {
  state:
    | { kind: "loading" }
    | { kind: "error" }
    | { kind: "ready"; data: ProductHistoryResponse }
    | null;
  onRetry?: () => void;
}) {
  if (!state) return null;
  if (state.kind === "loading")
    return (
      <>
        <h2 id="history-title">価格履歴</h2>
        <p className="loading-dialog" role="status">
          価格履歴を取得中…
        </p>
      </>
    );
  if (state.kind === "error")
    return (
      <>
        <h2 id="history-title">価格履歴</h2>
        <p role="alert">価格履歴を取得できませんでした。</p>
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            価格履歴を再読み込み
          </button>
        ) : null}
      </>
    );
  const { product, history } = state.data;
  return (
    <>
      <p className="maker">{product.manufacturer}</p>
      <h2 id="history-title">{product.model || product.title}</h2>
      {history.length ? <PriceHistorySparkline history={history} /> : null}
      <ol className="history">
        {history.length ? (
          history.map((entry: PriceHistoryEntry, index) => (
            <li key={`${entry.observed_at}-${index}`}>
              <time>{new Date(entry.observed_at).toLocaleString("ja-JP")}</time>
              <strong>{yen.format(entry.price_yen)}</strong>
              {index > 0 && entry.price_yen < history[index - 1].price_yen ? <span>↓</span> : null}
            </li>
          ))
        ) : (
          <li>履歴はまだありません。</li>
        )}
      </ol>
    </>
  );
}
