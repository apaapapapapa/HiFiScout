import type { MarketPriceBand, ProductMarketAnalysis } from "../src/api/contracts.js";
import { yen } from "./format.js";
import { isProductMarketAnalysis, MARKET_CONDITIONS, MARKET_UNITS } from "./market-analysis.js";

const price = (value: number | null) => (value === null ? "データ不足" : yen.format(value));
const period = (band: MarketPriceBand) =>
  band.first_observed_at && band.last_observed_at
    ? `${band.first_observed_at.slice(0, 10)} 〜 ${band.last_observed_at.slice(0, 10)}`
    : "観測なし";

function MonthlyPriceChart({ months }: { months: ProductMarketAnalysis["months"] }) {
  const prices = months.flatMap((month) => (month.median_yen === null ? [] : [month.median_yen]));
  if (prices.length < 2) return null;
  const low = Math.min(...prices),
    high = Math.max(...prices);
  const x = (index: number) => 90 + index * 94;
  const y = (value: number) => (high === low ? 75 : 25 + ((high - value) / (high - low)) * 95);
  let previous = false;
  const path = months
    .map((month, index) => {
      if (month.median_yen === null) {
        previous = false;
        return "";
      }
      const command = previous ? "L" : "M";
      previous = true;
      return `${command}${x(index)},${y(month.median_yen)}`;
    })
    .join(" ");
  return (
    <svg
      className="market-price-chart"
      viewBox="0 0 600 155"
      role="img"
      aria-label="月ごとの掲載価格中央値。欠けた月は結ばず、数値と観測件数は下の表に表示しています。"
    >
      <text x="2" y={high === low ? 78 : 28}>
        {yen.format(high)}
      </text>
      {high !== low ? (
        <text x="2" y="123">
          {yen.format(low)}
        </text>
      ) : null}
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
      {months.map((month, index) => (
        <g key={month.month}>
          <text x={x(index)} y="148" textAnchor="middle">
            {month.month.slice(5)}月
          </text>
          {month.median_yen !== null ? (
            <circle cx={x(index)} cy={y(month.median_yen)} r="3" fill="currentColor">
              <title>
                {month.month}: {yen.format(month.median_yen)}
              </title>
            </circle>
          ) : null}
        </g>
      ))}
    </svg>
  );
}

export function MarketAnalysis({ analysis }: { analysis: ProductMarketAnalysis | undefined }) {
  if (!isProductMarketAnalysis(analysis)) return null;
  return (
    <details className="market-analysis">
      <summary>状態別の価格帯・相場の推移</summary>
      <p>
        集計時点:{" "}
        <time dateTime={analysis.as_of}>{analysis.as_of.slice(0, 16).replace("T", " ")} UTC</time>
        。掲載価格の観測であり、成約価格ではありません。
      </p>
      {analysis.status === "limited" ? (
        <p>この製品の追加の相場集計は現在利用できません。各出品の価格・状態を確認してください。</p>
      ) : (
        <>
          <h3>現在の状態・販売単位別の価格帯</h3>
          <p>
            集計時点で在庫あり、直近90日以内に確認した出品です。状態ランクを共通点数に換算せず、単体・ペア・セットを分けています。3出品・2店舗未満では価格統計を控えます。
          </p>
          {analysis.current_conditions.length ? (
            <div
              className="market-table-scroll"
              role="region"
              aria-label="状態別の掲載価格"
              tabIndex={0}
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">状態の明記</th>
                    <th scope="col">販売単位</th>
                    <th scope="col">出品 / 店舗</th>
                    <th scope="col">中央値</th>
                    <th scope="col">掲載価格帯</th>
                    <th scope="col">観測期間 (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.current_conditions.map((band) => (
                    <tr key={`${band.condition}:${band.sale_unit}`}>
                      <th scope="row">{MARKET_CONDITIONS[band.condition]}</th>
                      <td>{MARKET_UNITS[band.sale_unit]}</td>
                      <td>
                        {band.listing_count}件 / {band.shop_count}店舗
                      </td>
                      <td>{price(band.median_yen)}</td>
                      <td>
                        {band.min_yen === null
                          ? "データ不足"
                          : `${price(band.min_yen)} 〜 ${price(band.max_yen)}`}
                      </td>
                      <td>{period(band)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>条件を集計できる在庫ありの出品はありません。</p>
          )}
          <h3>月ごとの掲載価格と掲載動向</h3>
          <p>
            各月・各出品の最後の掲載価格を1件として集計しています。販売単位・状態は混在し、過去の状態は推定しません。価格の変化がない継続出品は、記録が残らない月があります。今月は集計時点までの観測です。
          </p>
          <MonthlyPriceChart months={analysis.months} />
          <div
            className="market-table-scroll"
            role="region"
            aria-label="月次の掲載価格と観測件数"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">月 (UTC)</th>
                  <th scope="col">中央値</th>
                  <th scope="col">出品 / 店舗</th>
                  <th scope="col">初回観測</th>
                  <th scope="col">売切れ表示</th>
                  <th scope="col">掲載終了の観測</th>
                  <th scope="col">価格の観測期間 (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {analysis.months.map((month) => (
                  <tr key={month.month}>
                    <th scope="row">{month.month}</th>
                    <td>{price(month.median_yen)}</td>
                    <td>
                      {month.listing_count}件 / {month.shop_count}店舗
                    </td>
                    <td>{month.first_observed_listings}件</td>
                    <td>{month.sold_out_listings}件</td>
                    <td>{month.deactivated_listings}件</td>
                    <td>{period(month)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            初回観測は保存されている記録の最初の日で、店舗での掲載開始日とは限りません。売切れ表示と掲載終了には同じ出品が含まれる場合があり、合算できません。掲載終了だけで成約とは判断できず、観測なしも流通なしを意味しません。
          </p>
        </>
      )}
    </details>
  );
}
