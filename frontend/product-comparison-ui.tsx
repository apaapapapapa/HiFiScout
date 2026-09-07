import type { SpecificationPort } from "../src/api/catalog-specification-contracts.js";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ApiClient } from "./api-client.js";
import type { DisplayProduct } from "./types.js";
import { comparisonPath, loadComparisonProducts } from "./product-comparison.js";
import type { ComparisonColumn } from "./product-comparison.js";
import { productPermalinkPath } from "./product-permalink.js";
import { ProductPriceIndexSummary, productPriceIndex } from "./price-index-ui.js";
import { yen } from "./format.js";
import { ModelRelations } from "./model-relations-ui.js";

function priceRange(product: DisplayProduct): string {
  const low = product.lowest_price_yen;
  const high = product.highest_price_yen;
  return low == null
    ? "—"
    : high == null || low === high
      ? yen.format(low)
      : `${yen.format(low)}〜${yen.format(high)}`;
}

function activity(product: DisplayProduct): string {
  const value = product.latest_activity_at;
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("ja-JP")
    : "—";
}

function ports(items: SpecificationPort[] | null | undefined): string {
  if (items == null) return "記載なし";
  return items.length
    ? items
        .map((p) => `${p.connector}（${p.count == null ? "系統数未確認" : `${p.count}系統`}）`)
        .join(" / ")
    : "なし（確認済み）";
}

const rows: { label: string; cell: (product: DisplayProduct) => ReactNode }[] = [
  { label: "メーカー", cell: (p) => p.manufacturer || "—" },
  { label: "カテゴリ", cell: (p) => p.direct_categories?.join(" / ") || p.category || "—" },
  { label: "出品されている仕上げ", cell: (p) => p.presentation_colors?.join(" / ") || "—" },
  { label: "掲載中の価格帯", cell: priceRange },
  ...(
    [
      { key: "widthMm", label: "幅", unit: "mm" },
      { key: "heightMm", label: "高さ", unit: "mm" },
      { key: "depthMm", label: "奥行", unit: "mm" },
      { key: "weightKg", label: "重量", unit: "kg" },
    ] as const
  ).map(({ key, label, unit }) => ({
    label,
    cell: (p: DisplayProduct) =>
      p.specifications?.[key] == null ? "記載なし" : `${p.specifications[key]} ${unit}`,
  })),
  { label: "入力端子", cell: (p) => ports(p.specifications?.inputs) },
  { label: "出力端子", cell: (p) => ports(p.specifications?.outputs) },
  {
    label: "仕様の出典",
    cell: (p) =>
      p.specifications ? (
        <>
          <a href={p.specifications.sourceUrl} target="_blank" rel="noreferrer">
            参照資料
          </a>
          <br />
          登録・更新: {new Date(p.specifications.updatedAt).toLocaleDateString("ja-JP")}
        </>
      ) : (
        "記載なし"
      ),
  },
  { label: "在庫ありの出品", cell: (p) => `${p.in_stock_offer_count}件` },
  { label: "掲載中の出品・店舗", cell: (p) => `${p.offer_count}件 / ${p.shop_count}店舗` },
  { label: "最新の動き", cell: activity },
  {
    label: "機種の関係・シリーズ",
    cell: (p) =>
      p.model_relations ? <ModelRelations relations={p.model_relations} currentKey={p.key} /> : "—",
  },
  {
    label: "過去の出品価格の指標",
    cell: (p) => (productPriceIndex(p) ? <ProductPriceIndexSummary product={p} /> : "—"),
  },
];

export function ProductComparison({
  keys,
  api,
  onRemove,
  onClear,
}: {
  keys: string[];
  api: ApiClient;
  onRemove: (key: string) => void;
  onClear: () => void;
}) {
  const selection = keys.join(",");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ selection: string; columns: ComparisonColumn[] } | null>(
    null,
  );
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    void loadComparisonProducts(
      api,
      selection ? selection.split(",") : [],
      controller.signal,
      attempt > 0,
    )
      .then((columns) => {
        if (!controller.signal.aborted) setResult({ selection, columns });
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.error(error);
      });
    return () => controller.abort();
  }, [api, selection, attempt]);
  if (!keys.length) return null;
  const columns = result?.selection === selection ? result.columns : null;
  const path = comparisonPath(keys);
  const specificationNames = [
    ...new Set(
      (columns ?? []).flatMap((c) => c.product?.specifications?.main.map((s) => s.name) ?? []),
    ),
  ];
  const comparisonRows = [
    ...rows,
    ...specificationNames.map((name) => ({
      label: `仕様: ${name}`,
      cell: (p: DisplayProduct) =>
        p.specifications?.main.find((s) => s.name === name)?.value ?? "記載なし",
    })),
  ];
  return (
    <section className="product-comparison" aria-labelledby="product-comparison-title">
      <div className="comparison-toolbar">
        <h2 id="product-comparison-title">製品比較 ({keys.length}/4)</h2>
        {path ? <a href={path}>この比較の共有URL</a> : null}
        <button type="button" onClick={onClear}>
          比較を解除
        </button>
      </div>
      <p>
        確認済みの製品を2〜4件選べます。価格・在庫は検索条件にかかわらず、各製品の掲載中の出品を表示します。
      </p>
      <ul className="comparison-selection">
        {keys.map((key) => (
          <li key={key}>
            {columns?.find((column) => column.key === key)?.product?.model || key}
            <button type="button" aria-label={`${key}を比較から外す`} onClick={() => onRemove(key)}>
              外す
            </button>
          </li>
        ))}
      </ul>
      {keys.length < 2 ? (
        <p role="status">もう1件選ぶと比較できます。</p>
      ) : !columns ? (
        <p role="status">比較情報を読み込んでいます…</p>
      ) : (
        <>
          {columns.some((column) => !column.product) ? (
            <p role="status">
              取得できない製品があります。
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                比較情報を再読み込み
              </button>
            </p>
          ) : null}
          <div
            className="comparison-table-wrap"
            tabIndex={0}
            role="region"
            aria-label="製品の比較表（横にスクロールできます）"
          >
            <table className="comparison-table">
              <caption>
                価格は出品価格です。寸法・重量は本体1台分の登録仕様です。未登録の仕様は「記載なし」、出品価格等の欠損は「—」で表示します。
              </caption>
              <thead>
                <tr>
                  <th scope="col">比較項目</th>
                  {columns.map(({ key, product }) => (
                    <th scope="col" key={key}>
                      <a href={productPermalinkPath(key) || "/"}>{product?.model || key}</a>
                      {!product ? <p>取得できませんでした</p> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    {columns.map(({ key, product }) => (
                      <td key={key}>{product ? row.cell(product) : "—"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
