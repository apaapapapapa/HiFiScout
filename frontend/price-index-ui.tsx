import { dateFmt, yen } from "./format.js";
import type {
  DisplayPriceIndexListingEndObservation,
  DisplayPriceIndexSummary,
  DisplayProduct,
} from "./types.js";

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
    typeof raw.last_computed_at !== "string"
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
  if (!index || current == null || index.asking_median_yen <= 0) return null;

  const rawPercent = ((current - index.asking_median_yen) / index.asking_median_yen) * 100;
  const percent = Math.round(rawPercent);
  if (percent === 0) {
    return {
      label: "相場比 ±0%",
      title: "現在の最安出品価格は過去の出品価格中央値と同水準です",
      direction: "same",
    };
  }

  const below = percent < 0;
  const absolute = Math.abs(percent);
  return {
    label: `相場比 ${below ? "−" : "+"}${absolute}%`,
    title: `現在の最安出品価格は過去の出品価格中央値より${absolute}%${below ? "低い" : "高い"}水準です`,
    direction: below ? "below" : "above",
  };
}

export function RelativePriceBadge({ product }: { product: DisplayProduct }) {
  const badge = relativePriceBadge(product);
  if (!badge) return null;
  return (
    <span
      className={`badge price-index-badge price-index-badge-${badge.direction}`}
      title={badge.title}
    >
      {badge.label}
    </span>
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
            {dateFmt.format(new Date(observation.observed_at))}
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
    <section className="price-index-summary" aria-labelledby="price-index-title">
      <div className="price-index-heading">
        <div>
          <p className="price-index-kicker">PRICE INDEX</p>
          <h3 id="price-index-title">中古相場</h3>
        </div>
        <span>{index.asking_sample_count}件の出品価格から集計</span>
      </div>
      <div className="price-index-grid">
        <section className="price-index-indicator price-index-asking">
          <p className="price-index-label">出品価格の相場</p>
          <strong className="price-index-main-value">{yen.format(index.asking_median_yen)}</strong>
          <span className="price-index-caption">全期間の中央値</span>
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
    </section>
  );
}
