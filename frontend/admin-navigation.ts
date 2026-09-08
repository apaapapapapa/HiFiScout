export const ADMIN_VIEWS = [
  {
    id: "manufacturers",
    label: "メーカー・別名",
    description: "正式名称・表記揺れの影響を確認し、履歴を残して修正します。",
    group: "データの整備",
  },
  {
    id: "extraction",
    label: "抽出テスト",
    description: "保存済み商品やタイトルで、抽出結果と仮の別名ルールを比較します。",
    group: "データの整備",
  },
  {
    id: "operations",
    label: "負荷・稼働状況",
    description: "保存済みの使用量・失敗・本番バージョンを確認します。",
    group: "日常の管理",
  },
  {
    id: "jobs",
    label: "バックグラウンド処理",
    description: "CSV取込・再処理の進捗を確認し、停止・再開・失敗した対象の再試行を行います。",
    group: "データの整備",
  },
  {
    id: "crawls",
    label: "ショップ別クロール",
    description: "ショップごとの収集状況・予定停止を確認し、停止・再開・再実行します。",
    group: "日常の管理",
  },
  {
    id: "catalog",
    label: "製品カタログ",
    description: "メーカー共通の製品情報を検索・修正します。",
    group: "日常の管理",
  },
  {
    id: "listings",
    label: "登録商品",
    description: "販売店ごとの商品情報・色・出品条件を確認して修正します。",
    group: "日常の管理",
  },
  {
    id: "reports",
    label: "誤り報告",
    description: "利用者から届いた報告を確認し、対応状況を管理します。",
    group: "日常の管理",
  },
  {
    id: "duplicates",
    label: "重複の整理",
    description: "同じ製品の候補を比較し、残すカタログを選んで統合します。",
    group: "データの整備",
  },
  {
    id: "candidates",
    label: "未検証候補",
    description: "販売店から見つかった候補を確認し、カタログに登録します。",
    group: "データの整備",
  },
  {
    id: "csv",
    label: "CSV入出力",
    description: "データをダウンロードし、編集したCSVの差分を確認して一括更新します。",
    group: "データの整備",
  },
  {
    id: "maintenance",
    label: "出品条件の再処理",
    description: "保存済みの情報から出品条件を再判定し、充足率を確認します。",
    group: "データの整備",
  },
] as const;

export type AdminView = (typeof ADMIN_VIEWS)[number]["id"];
export type CatalogView = "catalog" | "duplicates" | "candidates" | "csv";

export function isCatalogView(view: AdminView): view is CatalogView {
  return view === "catalog" || view === "duplicates" || view === "candidates" || view === "csv";
}

export function adminLocation(location: { hash: string; search: string }): {
  view: AdminView;
  search: string;
} {
  const view = ADMIN_VIEWS.find((item) => `#${item.id}` === location.hash)?.id ?? "catalog";
  return { view, search: location.search };
}

export function adminViewUrl(href: string, view: AdminView): string {
  const url = new URL(href);
  for (const key of ["q", "shopKey", "scope", "manufacturerId", "categoryId", "jobId", "listingId"])
    url.searchParams.delete(key);
  url.hash = view === "catalog" ? "" : view;
  return `${url.pathname}${url.search}${url.hash}`;
}
