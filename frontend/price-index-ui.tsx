import { yen } from "./format.js";
import type {
  DisplayPriceIndexListingEndObservation,
  DisplayPriceIndexSummary,
  DisplayProduct,
} from "./types.js";

const listingEndDateFmt = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

interface RelativePriceBadgeModel {
  label: string;
  title: string;
  direction: "below" | "above" | "same";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || isNonNegativeNumber(value);
}

function listingEndObservation(value: unknown): DisplayPriceIndexListingEndObservation | null {
  if (!isRecord(value)) return null;
  if (!isNonNegativeNumber(value.price_yen)) return null;
  if (typeof value.observed_at !== "string" || !Number.isFinite(Date.parse(value.observed_at))) {
    return null;
  }
  if (value.signal_kind !== "sold_out" && value.signal_kind !== "deactivated") return null;
  return {
    price_yen: value.price_yen,
    observed_at: value.observed_at,
    signal_kind: value.signal_kind,
  };
}

/**
 * Validate the optional Step 3 projection at the presentation boundary.
 *
 * Older favorite snapshots have no `price_index`; malformed localStorage entries must not turn a
 * badge into a rendering failure. The listing-end observation array was added with Step 4, so an
 * older cached Step 3 payload is treated as an empty observation list during rollout.
 */
export function productPriceIndex(product: DisplayProduct): DisplayPriceIndexSummary | null {
  const raw: unknown = product.price_index;
  if (!isRecord(raw)) return null;
  if (
    !isNonNegativeInteger(raw.asking_sample_count) ||
    !isNonNegativeNumber(raw.asking_median_yen) ||
    !isNonNegativeNumber(raw.asking_min_yen) ||
    !isNonNegativeNumber(raw.asking_max_yen) ||
    !isNullableNonNegativeNumber(raw.recent_asking_median_yen) ||
    !isNonNegativeInteger(raw.listing_end_sample_count) ||
    !isNullableNonNegativeNumber(raw.listing_end_median_yen) ||
    !isNonNegativeInteger(raw.sold_out_signal_count) ||
    !isNonNegativeInteger(raw.deactivated_signal_count) ||
    typeof raw.last_computed_at !== "string" ||
    (raw.asking_listing_count !== undefined && !isNonNegativeInteger(raw.asking_listing_count)) ||
    (raw.asking_shop_count !== undefined && !isNonNegativeInteger(raw.asking_shop_count)) ||
    (raw.latest_asking_observed_at != null &&
      (typeof raw.latest_asking_observed_at !== "string" ||
        !Number.isFinite(Date.parse(raw.latest_asking_observed_at))))
  ) {
    return null;
  }

  const observationsRaw = raw.listing_end_observations;
  const observations = Array.isArray(observationsRaw)
    ? observationsRaw.flatMap((entry) => {
        const observation = listingEndObservation(entry);
        return observation ? [observation] : [];
      })
    : [];

  return {
    asking_sample_count: raw.asking_sample_count,
    ...(isNonNegativeInteger(raw.asking_listing_count)
      ? { asking_listing_count: raw.asking_listing_count }
      : {}),
    ...(isNonNegativeInteger(raw.asking_shop_count)
      ? { asking_shop_count: raw.asking_shop_count }
      : {}),
    ...(typeof raw.latest_asking_observed_at === "string"
      ? { latest_asking_observed_at: raw.latest_asking_observed_at }
      : {}),
    asking_median_yen: raw.asking_median_yen,
    asking_min_yen: raw.asking_min_yen,
    asking_max_yen: raw.asking_max_yen,
    recent_asking_median_yen: raw.recent_asking_median_yen,
    listing_end_sample_count: raw.listing_end_sample_count,
    listing_end_median_yen: raw.listing_end_median_yen,
    sold_out_signal_count: raw.sold_out_signal_count,
    deactivated_signal_count: raw.deactivated_signal_count,
    listing_end_observations: observations,
    last_computed_at: raw.last_computed_at,
  };
}

/** Card badge compares the currently visible lowest offer with the retained asking-price median. */
export function relativePriceBadge(product: DisplayProduct): RelativePriceBadgeModel | null {
  const index = productPriceIndex(product);
  const current = product.lowest_price_yen;
  if (
    !index ||
    Number(index.asking_listing_count || 0) < 3 ||
    current == null ||
    index.asking_median_yen <= 0
  )
    return null;

  const rawPercent = ((current - index.asking_median_yen) / index.asking_median_yen) * 100;
  const percent = Math.round(rawPercent);
  if (percent === 0) {
    return {
      label: "出品中央値比 ±0%",
      title: "表示中の最安出品価格は出品ごとの最新価格の中央値と同水準です",
      direction: "same",
    };
  }

  const below = percent < 0;
  const absolute = Math.abs(percent);
  return {
    label: `出品中央値比 ${below ? "−" : "+"}${absolute}%`,
    title: `表示中の最安出品価格は出品ごとの最新価格の中央値より${absolute}%${below ? "低い" : "高い"}水準です`,
    direction: below ? "below" : "above",
  };
}

export function RelativePriceBadge({ product }: { product: DisplayProduct }) {
  const badge = relativePriceBadge(product);
  if (!badge) return null;
  return (
    <details className={`price-explanation price-index-badge-${badge.direction}`}>
      <summary className="badge price-index-badge">{badge.label}</summary>
      <p>
        {badge.title}。{productPriceIndex(product)?.asking_listing_count}
        出品を対象に、各出品の最新価格を1件ずつ集計しています。
        成約価格ではなく、状態・付属品・単品やペアなどの差も含みます。
        「全店舗の最安値で割安な順」は全店舗の在庫価格を優先した最安値で並び、この表示は絞り込み後の価格を比較します。
      </p>
    </details>
  );
}

function ListingEndObservations({
  observations,
}: {
  observations: readonly DisplayPriceIndexListingEndObservation[];
}) {
  if (!observations.length) return null;
  return (
    <ol className="price-index-observations" aria-label="最近の掲載終了時価格の観測">
      {observations.map((observation, index) => (
        <li key={`${observation.observed_at}-${observation.price_yen}-${index}`}>
          <time dateTime={observation.observed_at}>
            {listingEndDateFmt.format(new Date(observation.observed_at))}
          </time>
          <strong>{yen.format(observation.price_yen)}</strong>
          <span>
            {observation.signal_kind === "sold_out" ? "売り切れ表示を確認" : "掲載終了を確認"}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Two deliberately distinct indicators: asking-price evidence and listing-end evidence. */
export function ProductPriceIndexSummary({ product }: { product: DisplayProduct }) {
  const index = productPriceIndex(product);
  if (!index) return null;

  return (
    <details className="price-index-summary">
      <summary>出品価格・掲載終了時価格の集計を見る</summary>
      <div className="price-index-heading">
        <div>
          <p className="price-index-kicker">PRICE INDEX</p>
          <h3 id="price-index-title">出品価格の参考値</h3>
        </div>
        <span>
          {index.asking_listing_count != null
            ? `${index.asking_listing_count}出品・${index.asking_shop_count}店舗から集計`
            : `${index.asking_sample_count}件の価格観測`}
        </span>
      </div>
      <div className="price-index-grid">
        <section className="price-index-indicator price-index-asking">
          <p className="price-index-label">出品価格の相場</p>
          <strong className="price-index-main-value">{yen.format(index.asking_median_yen)}</strong>
          <span className="price-index-caption">
            {index.asking_listing_count != null
              ? "出品ごとの最新価格の中央値"
              : "全期間の観測中央値"}
          </span>
          <dl className="price-index-stats">
            {index.recent_asking_median_yen != null ? (
              <>
                <dt>直近90日中央値</dt>
                <dd>{yen.format(index.recent_asking_median_yen)}</dd>
              </>
            ) : null}
            <dt>観測範囲</dt>
            <dd>
              {yen.format(index.asking_min_yen)}〜{yen.format(index.asking_max_yen)}
            </dd>
            <dt>観測数</dt>
            <dd>{index.asking_sample_count}件</dd>
            {index.latest_asking_observed_at ? (
              <>
                <dt>最新の価格観測</dt>
                <dd>{listingEndDateFmt.format(new Date(index.latest_asking_observed_at))}</dd>
              </>
            ) : null}
          </dl>
        </section>
        <section className="price-index-indicator price-index-listing-end">
          <p className="price-index-label">掲載終了時価格</p>
          {index.listing_end_median_yen != null ? (
            <>
              <strong className="price-index-main-value">
                {yen.format(index.listing_end_median_yen)}
              </strong>
              <span className="price-index-caption">掲載終了時に最後に観測した価格の中央値</span>
            </>
          ) : (
            <p className="price-index-empty">価格を伴う掲載終了の観測はまだありません。</p>
          )}
          <dl className="price-index-stats">
            <dt>掲載終了時価格</dt>
            <dd>{index.listing_end_sample_count}件</dd>
            <dt>売り切れ表示を確認</dt>
            <dd>{index.sold_out_signal_count}件</dd>
            <dt>その他の掲載終了</dt>
            <dd>{index.deactivated_signal_count}件</dd>
          </dl>
          <ListingEndObservations observations={index.listing_end_observations} />
          <p className="price-index-disclaimer">
            掲載終了時に最後に観測できた価格です。販売実績を示すものではありません。
          </p>
        </section>
      </div>
    </details>
  );
}
